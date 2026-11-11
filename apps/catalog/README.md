# Catalog

Catalog owns the network and the schedule: stations, trains and their coaches,
travel classes, coach layouts, timetables, dated trips and fares. Everything a
search result shows comes from here, and so does the job that turns a timetable
into the trips travellers can actually book.

This file records the decisions behind trip generation, fares and Cairo time —
the ones you cannot read off the code.

## What generates trips, how far ahead, and why

A timetable is a *pattern*: train 916 runs on these days, calling at these
stops, from this date. A **dated trip** is one run of it — "train 916 on 27
October" — with its own stops, its own instants, and a copy of the composition
of the timetable version it came from.

`TripsService` turns the first into the second. It runs on a self-rescheduling
timer (daily by default, `TRIP_GENERATION_INTERVAL_MS`), and also immediately
after a timetable is published.

**The window is 30 days plus a one-day margin.** Thirty days is the booking
window, so a traveller must find a trip on any date inside it. The extra day
means the last day of the window is already generated before it is needed,
rather than appearing only when the next tick happens to run.

**The window is always recomputed from today**, never from "where the last run
finished". That is what makes a missed day harmless: if the job is down for
three days, the next tick fills all three, because it never had a watermark to
fall behind. A job that tracked its own progress would leave a hole at the end
of the window exactly when it recovered.

**It is safe to run twice, and safe on two instances at once.** A dated trip is
unique per train and date, enforced by the database
(`uq_dated_trip_train_date`). Generation checks for an existing trip, inserts
if there is none, and if another instance won the race the unique violation is
caught and that instance's trip is returned. Only that violation is caught —
any other failure propagates, because "a row already exists" must never become
the explanation for an unrelated bug. A trip that already exists is returned
untouched and **no second event is published**, so inventory is never told
twice about the same run.

A trip's stop positions never change once it is published. Reconciling an
already-generated trip with a newer timetable version — withdrawing the ones
that will no longer run — belongs to the operations API (TA-20), not to
generation.

### Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `TRIP_GENERATION_ENABLED` | `true` | Off switch for the background job. The seed sets it to `false` so its own publish is the only thing generating. |
| `TRIP_GENERATION_INTERVAL_MS` | `86400000` | How often the job ticks. Lowered in tests so the second tick need not wait a day. |

## How fares are modelled

A fare depends on **train, class, and origin–destination pair**, in integer
piastres, with the instant it took effect:

```
fare(train, travel_class, origin_station, destination_station, effective_from)
  -> amount_piastres
```

**There is no service date in that key**, and deliberately so. A row per pair
per train per date would multiply every price change by the size of the booking
window. Instead a trip resolves each pair against the fare that was in force at
the moment its origin stop departs, which is both cheaper and the honest
answer to "what did this cost at 10:42 yesterday" (BR-30, BR-51). Adding a new
price is a new row with a later `effective_from`; nothing is overwritten, so the
history is always readable.

### Coverage is checked when you publish, not when you search

Every in-order pair of stops, for every class the train carries, must resolve to
exactly one positive whole number of piastres. A gap is a **publishing error**:
`publishTimetable` validates the whole timetable before it writes anything, so a
missing fare refuses the publish rather than surfacing as a broken search
result later. The refusal names every offending pair, not just the first one it
found.

Generation reads a train's whole fare set in one query and resolves pairs in
memory. A fifteen-stop route with three classes is 315 pair-and-class
combinations; asking the database for each one separately, once per date in the
window, is thousands of round trips for data that does not change between dates.

### A longer segment never costs less than one inside it

**Decision: sub-segment fares are monotonic, and this is enforced.** If a
segment runs from stop `i` to stop `j`, its fare must be greater than or equal
to the fare of every segment contained in it. Cairo → Aswan cannot be cheaper
than Cairo → Assiut.

The check compares each pair against the two pairs one stop shorter at either
end, which is enough: any contained segment is reached by shrinking one endpoint
at a time, so the property follows by induction. Equality is allowed — a flat
fare over the whole route is legitimate — only a strict decrease is refused.

The alternative was to permit it and document the anomaly. We chose enforcement
because a traveller who sees a longer journey priced lower reads it as a bug,
and because catching it at publish time turns a pricing mistake into an error
message for the operator instead of a support ticket.

## Cairo time, and the two nights it goes wrong

Every stop time in a timetable is an Africa/Cairo wall-clock reading. Every
stored instant is a `timestamptz`. The conversion between them goes through the
IANA time zone and reads the offset from tzdata — **never a hardcoded `+02:00`
or `+03:00`** — because Egypt observes daylight saving from late April to late
October, so which of the two applies depends on the date. `libs/contracts`'
`cairo-time.ts` is the only place that conversion lives.

A stop also carries a **day offset**, so an overnight train has stops on two
calendar dates and each stop knows its own. A train leaving Cairo at 23:00 and
reaching Aswan at 09:30 is offset 0 and offset 1; durations are the difference
between instants, never between clock readings.

Twice a year a wall-clock reading is not enough to identify an instant. Both
decisions are made here and pinned by tests in `cairo-time.spec.ts`:

**The spring-forward night — a time that never happens.** On the last Friday of
April the clock jumps from 00:00 to 01:00, so a train timetabled at 00:30 has
no 00:30 to leave at. **It moves forward to the instant the clock reached:
00:30 becomes 01:30.** It does not throw. A timetabled train still runs that
night, an hour later by the clock than the timetable says, which is what
actually happens to a train.

**The fall-back night — a time that happens twice.** At the end of October the
clock goes back, so 23:00–23:59 occur twice: once on summer time, once on
standard time. **An ambiguous time means the second occurrence, on standard
time (+02:00).** Cairo 23:30 on 29 October 2026 is `21:30Z`, not `20:30Z`. By
the time a passenger reads "23:30" on a clock that night the clocks have already
gone back, so the later instant is the departure they would turn up for.

## Adjacency: which seats count as side by side

A coach layout is a list of rows, and each row has its seats split into a left
side and a right side — that split *is* the aisle:

```json
{ "rowNumber": 1, "leftSeats": ["1", "2"], "rightSeats": ["3"] }
```

**Two seats are adjacent when they are in the same row and on the same side.**
Seats 1 and 2 above are adjacent; 2 and 3 are not, because the aisle is between
them. A 2+1 layout is expressed by giving one side a single seat, as here, and
needs no special case anywhere.

Capacity is **derived** from this and never stored: a class's capacity on a trip
is the number of seats in that class's coaches. There is no capacity column to
disagree with the seats. The layout travels inside the `catalog.trip.published`
event, so inventory (Sprint 3) can create seats and group them without reading
catalog's database.

## Events, and where they wait

Generation writes the trip, its stops, its composition snapshot and its event
**in one transaction**, through the outbox. Either all of it commits or none of
it does; nothing is announced that was not stored.

| Event | Consumed by |
| --- | --- |
| `catalog.trip.published` | inventory (Sprint 3) — creates the trip's seats per class and segment |
| `catalog.trip.withdrawn` | inventory (Sprint 3) — removes seats for a run that will not happen |
| `catalog.timetable.published` | catalog's own cache invalidation (CAT-5) |

### Catalog consumes on one queue per event type

CAT-5 reads four event types, and each has **its own queue**:

```
catalog.invalidation.fare-changed
catalog.invalidation.timetable-published
catalog.invalidation.station-changed
catalog.invalidation.seat-availability-changed
```

They must not share one. A subscription validates each delivery against its own
`eventType`, so four subscriptions on a shared queue receive the deliveries
round-robin and reject the three types that are not theirs as `invalid-payload`.
Measured on the shared queue it once had: two of eight events handled, six
dead-lettered. Catalog also owns a `processed_event` table so a redelivery is
skipped rather than applied twice.

> Upgrading an existing broker leaves the old `catalog.invalidation` queue and
> its retry/DLQ siblings behind with nothing reading them. They are safe to
> delete once drained; a fresh `docker compose up` never creates them.

**Inventory does not exist yet, and an AMQP message sent to an exchange with no
queue bound to it is silently dropped.** Worse, the outbox relay marks a row
published as soon as the broker accepts it, so the outbox would not notice.

So **inventory declares the queue itself, before it can read it**:
`TripLifecycleTopologyService`
(`apps/inventory/src/modules/trip-lifecycle/`) asserts
`inventory.trip-lifecycle` bound to `train.events` on both trip routing keys at
boot, with the retry and dead-letter queues a consumer would get, and then
**does not consume**. Trip events accumulate there from the first run. Sprint 3
adds an `EventConsumerService` subscription on the same queue name, which
re-asserts the identical topology and starts draining the backlog.

This is the same ownership rule the rest of the platform follows
(`libs/messaging/src/amqp-topology.ts`): the producer declares the exchange and
nothing else, and each consumer declares its own queues and bindings — exactly
how notification's queues come to exist. Catalog never names a consumer.

> Because the queue lives with its consumer, inventory has to have started at
> least once for the backlog to be kept. It is in Compose alongside everything
> else, so `docker compose up` is enough; notification carries the same
> property.

## Seeding

```bash
docker compose exec catalog npm run catalog:seed
```

It runs the compiled seed out of `dist/`, which is what the image already
carries. On the host, build first with `npm run catalog:seed:build`.

This seeds a small network and then **publishes a timetable through
`TimetablesService.publishTimetable`** — the same call the operations API makes.
Its trips are therefore generated and announced exactly like real ones, with
real outbox rows. There are no raw inserts into `dated_trip` that would skip the
outbox and give the system trips nothing was ever told about.

The seed turns off both background jobs while it runs. Generation would
otherwise start on boot, before the seed has written anything, and race the
seed's own publish for the same dates. The relay is off because the seed exits
as soon as it is finished, and a tick racing that exit can claim outbox rows and
die mid-publish; the rows stay unpublished and the running service ships them,
which is its job and not the seed's.

> `npm run catalog:seed:search` and `npm run catalog:seed:today` are the older
> search fixtures. They insert dated trips directly, which is fine for exercising
> search but does not produce the events inventory needs. Use `catalog:seed`
> when you care about the publishing path.
