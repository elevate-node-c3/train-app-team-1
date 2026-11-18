# Inventory Service

The Inventory service is the authoritative owner of train seat inventory, coach topologies, seat occupation, and pure group seat allocation (`SEAT-1`, `SEAT-3`).

This document details the pure group seat allocation engine: coach layout geometry, the tiered fallback order, and the tie-breaking hierarchies that make allocation deterministic. The seat tables it reads, and the occupation rules that decide what is free, are documented alongside the schema in `src/modules/seats/`.

## MT-02 Current Hold Lifecycle

Holds are created only here. The SEAT-2 `allocateGroupSeats` engine documented
below is reused as-is; there is no second allocator and no per-leg
hold-then-compensate flow.

1. `POST /api/v1/bookings` requires the existing Gateway `bookable` access level.
   An incomplete profile receives `403 PROFILE_INCOMPLETE` before Booking is called.
2. Send a UUID `bookingKey` (or the matching `Idempotency-Key` header), one to four
   saved `passengerIds`, and one or two `legs`. Each leg contains `tripId`,
   `travelClassId`, `originStationId`, and `destinationStationId`. Inline National
   IDs, names, caller-controlled owners/tokens, seat selection, and count-only
   payloads are not accepted.
3. Booking persists the key, authenticated owner, and immutable request intent.
   Identity's private `ResolveHoldPassengers` resolves only that owner's saved
   passengers. Booking persists the returned display snapshot and ten-star,
   last-four mask before asking Inventory for ownership.
4. Identity emits trip-scoped HMAC-SHA256 comparison tokens, not raw National IDs.
   Canonical digit variants match across accounts on the same dated trip. A
   durable immutable trip/key-version/fingerprint pin protects retries and key
   rotation.
5. Booking calls `CreateHold` once with every leg and passenger. Inventory locks
   the booking key, traveller guard, old hold, and sorted trips; reads current
   PostgreSQL facts; reclaims expired claims; runs the existing allocator; then
   commits every assignment, replacement, and held/released event together.
   A failed return leg or failed replacement leaves no partial new hold.
6. The common expiry is `min(clock_timestamp() + 15 minutes, every boarding
   departure - 15 minutes)`. `ExtendHold` adds five minutes to the existing expiry
   at most once, capped by the current cutoff. Expired/terminal holds cannot extend.
7. Timeouts have an unknown outcome, not a new booking key. Booking retries/reads
   the same durable intent and returns `reconciliationPending` when necessary.
   `ReleaseHold` is owner/key based and fences a late create even when no hold ID
   was received. Booking's consumers fence changes by aggregate version, so an
   older held event cannot revive an expired/released booking.

### Database and Worker

Current storage is `seat_hold_group`, `seat_hold_leg`, `seat_hold_passenger`,
`seat_hold_assignment`, `seat_hold_owner_guard`, and the existing
`seat_occupation` table. PostgreSQL half-open segment exclusions permit touching
segments and reject intersecting seat or passenger-token claims. National-ID
overlap is scoped to the same dated trip, independently of account or class.

`HoldExpiryWorker` starts only after successful migrations and immediately scans
stored deadlines. `HoldCoreService.expireDueHolds` claims bounded batches with
`FOR UPDATE SKIP LOCKED`, takes the established trip locks, and releases every
occupation plus one expiry event in the same transaction. Two instances skip
each other's claimed heads. No in-memory per-hold timers, last-run watermarks,
or RabbitMQ availability are involved in the expiry decision. The idle wake-up
only schedules another database scan. Request-time reclamation makes overdue
seats reusable before a worker catches up; immutable receipts still allow an
expiry event after occupation-history cleanup.

The existing outbox relay drains a healthy backlog without sleeping between
batches. Inventory uses bounded parallel confirms and one publication-mark query
per claimed batch; other services remain serial unless explicitly configured.
Hold events use persistent messages, mandatory routing, bounded
publisher confirms, and stable event IDs on retry. `published_at` uses the
database wall clock after confirmation. Delivery remains at-least-once;
Booking has distinct durable queues for held, released, expired, and extended
events and idempotent, version-fenced effects. A mandatory confirm proves at
least one route, not the presence of every intended consumer.

Inventory defensively refuses timetable updates that shorten a live hold's
promised cutoff or change its assigned class. Expired occupations no longer
block safe republishing. Before committing publication, Catalog also consults
Inventory usage and rejects stop/time, withdrawal, coach, class, layout, or seat
geometry changes for in-use trips. The Inventory refusal remains defense in depth.

### Runtime and Rollout

- `HOLD_CREATION_ENABLED=false` is the default. Disabling creation does not
  disable release, expiry scans, or outbox publication.
- Identity alone receives `HOLD_PASSENGER_TOKEN_KEYS`, a JSON object mapping
  positive integer versions to base64 keys of at least 32 bytes, and
  `HOLD_PASSENGER_TOKEN_ACTIVE_VERSION`. Keep every pinned key; never replace
  key material under an existing version. These are not access-token keys.
- Identity alone receives `NATIONAL_ID_ENCRYPTION_KEYS`,
  `NATIONAL_ID_ACTIVE_KEY_VERSION`, and `NATIONAL_ID_BLIND_INDEX_KEY`.
  The forward migration encrypts only `account.national_id` and
  `passenger.national_id` with AES-256-GCM and replaces National-ID uniqueness
  lookups with HMAC blind indexes. Retain old encryption versions for reads;
  never reuse the comparison-token, JWT, or service credentials for storage.
- Defaults: expiry batch 500, idle scan 250 ms; Inventory outbox batch 100,
  idle scan 100 ms, 32 in-flight confirms per instance; AMQP confirmation
  deadline 5000 ms. Environment values are
  bounded and validated. No value changes the 15-minute database deadline.
- Provision the required durable consumer queues/bindings before enabling
  creation. Monitor unpublished outbox age, oldest overdue held head, retries,
  and DLQs. Consumers being offline must not remove their durable queues.
- Apply additive migrations first. Existing anonymous legacy active/sold
  occupations require authoritative Identity/Booking backfill or a completed
  drain before activation. Creation checks this condition in PostgreSQL on every
  RPC and refuses while unidentified live rows remain, even when the feature flag
  is enabled. Expired legacy rows do not block readiness. Do not guess a passenger
  token or delete live rows.
- PostgreSQL must not log parameter values, failing statements, or constraint
  detail containing comparison tokens. Compose sets `log_error_verbosity=terse`,
  `log_min_error_statement=panic`, and `log_parameter_max_length_on_error=0`.
  Apply equivalent settings to externally managed databases.

### Isolated Verification

Use the separate project, not the normal e2e harness (which removes volumes):

```powershell
docker compose -f docker-compose.mt02-test.yml -p train-app-mt02-test up
pnpm test:mt02
pnpm exec vitest run test/contracts/hold-events.contract.spec.ts
docker compose -f docker-compose.mt02-test.yml -p train-app-mt02-test stop
```

The first command runs in a separate terminal. This stack publishes only local
test ports: PostgreSQL `25432`, AMQP `35672`, management `35673`. Fixtures use
service roles and refuse non-dedicated database targets. Test data and volumes
belong exclusively to `train-app-mt02-test`; do not point cleanup at the normal
developer database. `pnpm test:mt02` does not use `--passWithNoTests`.

The hold-core suite covers a 50-iteration last-seat race, concurrent touching
and intersecting segments, replacement rollback, release/create fencing,
extension races, multi-instance expiry ownership, transaction rollback when
outbox insertion fails, and hour-aged deadlines. Contract tests exercise all
four producer payloads against the actual Booking parser, including additive
fields, version refusals, and sensitive-field exclusion. The load/recovery
suite must report all 10,000 unique expiry events durably routed and every
release/publication committed within 60 seconds of the common DB deadline;
percentiles alone are not sufficient evidence.

### Remaining Activation Gates

- Catalog consumes all four lifecycle events on separate durable queues and
  advances a per-trip availability generation, invalidating exact and overlapping
  cached segments without Redis scans. An authoritative Catalog count projection
  belongs to SEAT-4 and is not required by MT-02; Inventory always uses PostgreSQL
  facts for hold decisions.
- Authoritative legacy occupation backfill, real secret provisioning/retention,
  production monitoring, and an actual hour-long outage soak remain operational
  activation work. Hour-aged fixtures plus a real broker restart prove recovery
  mechanics, not an elapsed one-hour production soak.

Exact MT-02 production/soak actions:

1. Back up Identity, provision all purpose-specific keys, and run additive
   migrations before enabling hold creation. Verify every non-null Identity
   National-ID value begins with `nid:v1:` and every associated blind index is
   64 hex characters; abort activation if any plaintext row remains.
2. Provision all Booking and Catalog durable hold-event queues/bindings, start
   two Inventory instances, then enable `HOLD_CREATION_ENABLED=true` only after
   the legacy-occupation readiness guard passes.
3. In a production-like isolated environment, record database time and pending
   event IDs, stop both Inventory workers and RabbitMQ for at least 60 minutes,
   then restart RabbitMQ and both instances without deleting volumes.
4. Verify no `seat_hold_group` row remains `held` past `expires_at`, every due
   hold has exactly one `inventory.hold.expired` outbox ID, every such row has a
   post-confirm `published_at`, and the durable capture queue contains the same
   unique IDs. Repeat scans and confirm counts do not increase.

---

---

## Table of Contents

- [MT-02 Current Hold Lifecycle](#mt-02-current-hold-lifecycle)
  - [Database and Worker](#database-and-worker)
  - [Runtime and Rollout](#runtime-and-rollout)
  - [Isolated Verification](#isolated-verification)
  - [Remaining Activation Gates](#remaining-activation-gates)
- [1. Service Overview & Flow](#1-service-overview--flow)
- [2. Strict Tiered Fallback Order](#2-strict-tiered-fallback-order)
- [3. Coach Layout Adjacency & Visual Diagrams](#3-coach-layout-adjacency--visual-diagrams)
  - [3.1 The Aisle Separation Barrier](#31-the-aisle-separation-barrier)
  - [3.2 2+2 Seating Layout](#32-22-seating-layout)
  - [3.3 3+2 Seating Layout](#33-32-seating-layout)
  - [3.4 Allocation Patterns by Group Size](#34-allocation-patterns-by-group-size)
    - [Solo Traveller (Group of 1) & Pair Preservation](#solo-traveller-group-of-1--pair-preservation)
    - [Group of 2 (Row Pair)](#group-of-2-row-pair)
    - [Group of 3 (Contiguous Row or 2+1 Cluster)](#group-of-3-contiguous-row-or-21-cluster)
    - [Group of 4 (2x2 Column-Aligned Block)](#group-of-4-2x2-column-aligned-block)
- [4. Deterministic Tie-Breaking Rules](#4-deterministic-tie-breaking-rules)
  - [Tier 1 (`SIDE_BY_SIDE`)](#tier-1-side_by_side)
  - [Tier 2 (`SAME_COACH`)](#tier-2-same_coach)
  - [Tier 3 (`SPLIT`)](#tier-3-split)
  - [Companion Pair Metric](#companion-pair-metric)
- [5. Seat Tables the Engine Reads](#5-seat-tables-the-engine-reads)
  - [5.1 Where Free Seats Come From](#51-where-free-seats-come-from)
  - [5.2 Multi-Leg Atomicity](#52-multi-leg-atomicity)
- [6. gRPC Interfaces & Contracts](#6-grpc-interfaces--contracts)

---

## 1. Service Overview & Flow

In the train reservation system, travellers booking together expect to sit together. In legacy systems, passengers were frequently split across coaches without notice, or forced into manual seat selection.

The inventory service replaces manual seat maps and opaque "auto-assign" logic with a **deterministic, server-managed group seat allocation engine**:

```
[ Client ]
   │
   │ 1. POST /api/v1/bookings (groupSize: 1..4, travelClassId, tripId)
   ▼
[ Gateway ]
   │ (Enforces seat-selection ban: rejects requests containing seatId or coachNumber)
   ▼
[ Booking Service ]
   │ 2. Persists the booking key, owner and immutable request intent
   │ 3. Invokes Inventory gRPC CreateHold() once, with every leg
   ▼
[ Inventory Service ]
   │ 4. Transaction start:
   │    a. Resolves the station pair to a trip_stop segment [from, to)
   │    b. Loads the trip's trip_seat rows and the seat ids occupied over it
   │    c. Pre-check: if free seats < groupSize -> REJECT (INSUFFICIENT_SEATS)
   │    d. Pure Allocator: allocateGroupSeats({ seats, occupiedSeatIds, groupSize })
   │    e. Writes seat_occupation rows; the exclusion constraint settles races
   │       (every leg allocated and committed in one transaction)
   │ 5. Returns HoldView (holdId, outcome, legs, assignments, expiresAt)
   ▼
[ Booking Service ]
   │ 6. A failed leg rolls the whole hold back; there is nothing to compensate
   │ 7. Returns booking draft to client with allocation outcome & notice
   ▼
[ Client ] (Receives transparent seat allocation outcome before payment)
```

### Core Invariants

1. **Pure & Deterministic Core**: Allocation is a pure function of `(seats, occupiedSeatIds, groupSize)` with zero database, clock, or network dependencies (`allocateGroupSeats()`). It reads `trip_seat`'s own columns, so adjacency means the same thing in the engine as in the schema.
2. **Never Silent**: The service never silently downgrades seat proximity. Every hold explicitly reports its outcome tier: `SIDE_BY_SIDE`, `SAME_COACH`, or `SPLIT`. When split, bilingual notifications are attached.
3. **All-or-Nothing Availability**: If fewer seats are free across the requested travel hops than the group requires, the service refuses the hold completely with error code `INSUFFICIENT_SEATS` and reports the exact count of remaining seats (`availableCount`). Partial holds ($N-1$ seats for a group of $N$) are never granted.
4. **Independent Legs**: On round trips, each leg is evaluated independently with its own outcome and seat assignments.

---

## 2. Strict Tiered Fallback Order

The allocation engine evaluates candidate seats through three strict, non-overlapping priority tiers:

```
┌────────────────────────────────────────────────────────┐
│                      Tier 1:                           │
│                SIDE_BY_SIDE                            │
│  - All passengers adjacent in a single coach           │
│  - Group 2: adjacent row pair on same aisle side       │
│  - Group 3: 3 in same row, or 2+1 adjacent-row cluster │
│  - Group 4: 2x2 column-aligned block across 2 rows     │
└──────────────────────────┬─────────────────────────────┘
                           │ (No valid cluster fits group)
                           ▼
┌────────────────────────────────────────────────────────┐
│                      Tier 2:                           │
│                  SAME_COACH                            │
│  - All passengers seated in the same coach             │
│  - Minimizes row span: max(row) - min(row)             │
│  - Strictly preferred over any split across coaches,   │
│    even if the split would keep pairs together         │
└──────────────────────────┬─────────────────────────────┘
                           │ (No single coach has >= N free seats)
                           ▼
┌────────────────────────────────────────────────────────┐
│                      Tier 3:                           │
│                      SPLIT                             │
│  - Distributed across minimal number of coaches (>= 2) │
│  - Maximizes companion pairs within partitions         │
│  - Includes bilingual user notification:               │
│    "تم توزيع المقاعد عبر أكثر من عربة لعدم توفر        │
│     مقاعد متجاورة كافية"                               │
└────────────────────────────────────────────────────────┘
```

---

## 3. Coach Layout Adjacency & Visual Diagrams

### 3.1 The Aisle Separation Barrier

Coach layouts define seat geometry using rows and aisle sides (`leftSeats` and `rightSeats`).

> [!IMPORTANT]
> **Aisle Boundary Rule**: The central aisle is a strict physical and social barrier. Seats on opposite sides of the aisle in the same row are **never adjacent** and **never side-by-side**. Numeric proximity in seat numbers (e.g. Seat 2 and Seat 3) does not constitute adjacency when an aisle separates them.

```
       LEFT SEATS (Window + Aisle)        AISLE        RIGHT SEATS (Aisle + Window)
   +---------------------------------+             +---------------------------------+
   |      Col 0             Col 1    |     ===     |      Col 0             Col 1    |
   |  +------------+   +------------+|    |   |    |+------------+   +------------+  |
R1 |  |  Seat 1A   |   |  Seat 1B   ||    |   |    ||  Seat 1C   |   |  Seat 1D   |  |
   |  +------------+   +------------+|    |   |    |+------------+   +------------+  |
   |  \______________v______________/|    |   |    |\______________v______________/  |
   |            VALID PAIR           |    |   |    |           VALID PAIR            |
   +---------------------------------+    |   |    +---------------------------------+
                                          | X |
                                1B <------+---|------> 1C
                                     NOT ADJACENT!
                               (AISLE BARRIER VIOLATION)
```

---

### 3.2 2+2 Seating Layout

The standard 2+2 coach layout consists of 2 seats on the left of the aisle and 2 seats on the right of the aisle in each row.

```
=============================================================================
                          2+2 COACH SEATING LAYOUT
=============================================================================
Direction of Travel ──►

         LEFT SIDE                              RIGHT SIDE
      Col 0       Col 1           AISLE      Col 0       Col 1
    (Window)     (Aisle)          |   |     (Aisle)     (Window)
   ┌─────────┐ ┌─────────┐        |   |    ┌─────────┐ ┌─────────┐
R1 │ Seat 01 │ │ Seat 02 │        |   |    │ Seat 03 │ │ Seat 04 │
   └─────────┘ └─────────┘        |   |    └─────────┘ └─────────┘
   ┌─────────┐ ┌─────────┐        |   |    ┌─────────┐ ┌─────────┐
R2 │ Seat 05 │ │ Seat 06 │        |   |    │ Seat 07 │ │ Seat 08 │
   └─────────┘ └─────────┘        |   |    └─────────┘ └─────────┘
   ┌─────────┐ ┌─────────┐        |   |    ┌─────────┐ ┌─────────┐
R3 │ Seat 09 │ │ Seat 10 │        |   |    │ Seat 11 │ │ Seat 12 │
   └─────────┘ └─────────┘        |   |    └─────────┘ └─────────┘
```

---

### 3.3 3+2 Seating Layout

Higher-density coaches feature 3 seats on the left side (or right side) and 2 seats on the other.

```
=============================================================================
                          3+2 COACH SEATING LAYOUT
=============================================================================
Direction of Travel ──►

               LEFT SIDE (3 Seats)                AISLE        RIGHT SIDE (2 Seats)
      Col 0          Col 1          Col 2         |   |       Col 0          Col 1
    (Window)       (Middle)        (Aisle)        |   |      (Aisle)        (Window)
   ┌─────────┐    ┌─────────┐    ┌─────────┐      |   |    ┌─────────┐    ┌─────────┐
R1 │ Seat 01 │    │ Seat 02 │    │ Seat 03 │      |   |    │ Seat 04 │    │ Seat 05 │
   └─────────┘    └─────────┘    └─────────┘      |   |    └─────────┘    └─────────┘
   \___________________v___________________/      |   |    \___________v___________/
            3 CONTIGUOUS SEATS IN A ROW           |   |           2-SEAT PAIR
                (Priority for N=3)                |   |
```

---

### 3.4 Allocation Patterns by Group Size

#### Solo Traveller (Group of 1) & Pair Preservation

To maximize availability for upcoming companion bookings, solo travellers are steered away from intact pairs. The allocator evaluates solo candidate seats according to a strict category hierarchy:

1. **Category 1 (Broken Pair)**: A seat on a multi-seat aisle side where at least one companion seat in the same row and side is already reserved or held.
2. **Category 2 (Isolated Seat)**: An individual seat that has no companion seats on its side of the row.
3. **Category 3 (Intact Pair / Cluster)**: A seat where all seats on its side and row are free (taken only when no broken pairs or isolated seats exist).

```
SOLO TRAVELLER PAIR PRESERVATION LOGIC:

Row 1: [ (OCCUPIED)  [ 1B (FREE) ] ]   | AISLE |   [ 1C (FREE)   1D (FREE) ]
                      ▲                             ▲
                      │                             │
          Category 1: BROKEN PAIR           Category 3: INTACT PAIR
          (Companion is occupied)           (Both seats free)

==> RESULT: Allocator picks 1B.
    Row 1 Right [1C, 1D] remains intact for an incoming group of 2 or 4!
```

#### Group of 2 (Row Pair)

For a group of 2, the allocator requires 2 adjacent seats in the same row on the same side of the aisle:

```
Row K: [ [ Seat K·0 ] [ Seat K·1 ] ]   | AISLE |   [ Seat K·2 ] [ Seat K·3 ]
         └──────────┬───────────┘
               Assigned Group of 2
```

#### Group of 3 (Contiguous Row or 2+1 Cluster)

For a group of 3, the allocator evaluates candidate clusters in two distinct passes:

- **Pass 1 (Contiguous Row on 3+ Side)**: On coaches with 3 seats on one side (e.g. 3+2 layout), 3 adjacent seats in the same row on the same side take top priority:
  ```
  Row K: [ [ Col 0 ]  [ Col 1 ]  [ Col 2 ] ]  | AISLE |  [ Col 0 ]  [ Col 1 ]
           └──────────────┬──────────────┘
               3 Contiguous in Same Row
  ```

- **Pass 2 (2+1 Cluster across Adjacent Rows)**: On 2+2 layouts, 3 passengers cannot sit in one row on the same side. The allocator selects a 2-seat companion pair in row $K$ and 1 column-aligned seat directly in front or behind in row $K+1$:
  ```
  Configuration A (Pair in Row K, Aligned Single in Row K+1):
  Row K:   [ [ Seat K·0 ]   [ Seat K·1 ] ]   | AISLE |   [ ... ]
  Row K+1: [ [ Seat K+1·0 ]   (free)     ]   | AISLE |   [ ... ]
             └──────────────┬──────────┘
                  2+1 Cluster A

  Configuration B (Aligned Single in Row K, Pair in Row K+1):
  Row K:   [ [ Seat K·0 ]     (free)     ]   | AISLE |   [ ... ]
  Row K+1: [ [ Seat K+1·0 ] [ Seat K+1·1 ] ] | AISLE |   [ ... ]
             └──────────────┬──────────┘
                  2+1 Cluster B
  ```

#### Group of 4 (2x2 Column-Aligned Block)

For a group of 4, the allocator selects a 2x2 block spanning two adjacent rows ($K$ and $K+1$) on the same side of the aisle:

```
Row K:   [ [ Seat K·0   ] [ Seat K·1   ] ]   | AISLE |   [ ... ]
Row K+1: [ [ Seat K+1·0 ] [ Seat K+1·1 ] ]   | AISLE |   [ ... ]
           └──────────────┬──────────────┘
               2x2 Column-Aligned Block
```

---

## 4. Deterministic Tie-Breaking Rules

When multiple candidate clusters or seat combinations qualify within a tier, ties are broken deterministically using documented properties. No random selections or machine-dependent iterations are permitted.

### Tier 1 (`SIDE_BY_SIDE`)

1. **Lowest `coachNumber`**: Lower-numbered coach selected first.
2. **Lowest starting `rowNumber`**: Lower row index selected first.
3. **Aisle side**: `left` seats are preferred over `right` seats.
4. **Lowest `columnIndex`**: Inner/lower column index preferred.

*Solo Traveller Tie-Breaker*:
Candidates are sorted by Category (`1` broken pair < `2` isolated seat < `3` intact pair), then lowest `coachNumber`, lowest `rowNumber`, `left` before `right`, and lowest `columnIndex`.

### Tier 2 (`SAME_COACH`)

When no single coach has a valid Tier 1 cluster, the allocator searches for $N$ seats within a single coach that keep passengers as physically close as possible:

1. **Smallest row span**: Minimizes $\text{span} = \max(\text{row}) - \min(\text{row})$ across the assigned seats.
2. **Highest number of companion pairs**: Maximizes disjoint 2-seat adjacent pairs (`countCompanionPairs`).
3. **Lowest `coachNumber`**: Lower coach numbers break ties.
4. **Lowest starting `rowNumber`**: Lower minimum row index breaks ties.
5. **Lowest seat order**: Deterministic row, side, column, and seatNumber ordering.

```
TIER 2 ROW SPAN COMPARISON EXAMPLE (Group of 3):

Coach A:
Row 2: [ [ 2A ]  ---  ]  | AISLE |  [ [ 2C ]  ---  ]
Row 3: [ [ 3A ]  ---  ]  | AISLE |  [  ---    ---  ]
Row Span = max(3) - min(2) = 1 row difference  <== WINS!

Coach B:
Row 1: [ [ 1A ]  ---  ]  | AISLE |  [  ---    ---  ]
Row 2: [ [ 2A ]  ---  ]  | AISLE |  [  ---    ---  ]
Row 5: [ [ 5A ]  ---  ]  | AISLE |  [  ---    ---  ]
Row Span = max(5) - min(1) = 4 row difference  <== LOSES!
```

### Tier 3 (`SPLIT`)

When no single coach has $\ge N$ free seats, the allocator partitions $N$ passengers across multiple coaches ($K \ge 2$):

1. **Fewest coaches used ($K$)**: A 2-coach split strictly beats a 3-coach split.
2. **Highest count of companion pairs**: Maximizes passengers kept together in 2-seat side-by-side pairs across the coaches.
3. **Lowest coach numbers**: Lexicographically lowest coach number list.
4. **Lowest row numbers and seat order**: Deterministic row and seat ordering within coaches.

### Companion Pair Metric

The companion pair count is computed by `countCompanionPairs(seats)`:

- Groups candidate seats by `${coachNumber}:${rowNumber}:${side}`.
- Sorts `seatIndexInSide` in ascending order.
- Counts non-overlapping adjacent index pairs (`idx[i+1] === idx[i] + 1`).

---

## 5. Seat Tables the Engine Reads

The allocator owns no tables. It consumes `trip_seat` rows joined to their
`trip_coach`, which the trip publication flow writes (`src/modules/seats/`):

| Engine field      | Column                         |
| ----------------- | ------------------------------ |
| `seatId`          | `trip_seat.id`                 |
| `coachNumber`     | `trip_coach.coach_number`      |
| `rowNumber`       | `trip_seat.row_number`         |
| `side`            | `trip_seat.side`               |
| `seatIndexInSide` | `trip_seat.seat_index_in_side` |
| `seatNumber`      | `trip_seat.seat_number`        |

Because `side` and `seat_index_in_side` are stored per seat, the engine never
reconstructs a layout from seat numbers — the aisle barrier of
[§3.1](#31-the-aisle-separation-barrier) is a column, not an inference.

### 5.1 Where Free Seats Come From

`occupiedSeatIds` holds the `trip_seat` ids blocked over the wanted segment.
Occupation lives in `seat_occupation`, keyed by an `int4range` segment, and a
seat counts as blocked when it is `sold`, or `held` with an unexpired
`hold_expires_at`. Segments are half-open `[from, to)`, so touching legs share a
seat while overlapping ones collide — see `src/modules/seats/segment.ts`.

Two guarantees belong to the database, not the allocator:

- **No double booking**: a Postgres exclusion constraint on
  `(trip_seat_id, segment)` rejects an overlapping occupation outright, so a
  race between two groups is settled by the write, not by the snapshot either
  group read.
- **Expiry**: counts may use `now()`; the exclusion constraint's predicate may
  not. An expired-but-unreleased hold therefore still blocks a write.

The allocator sees only a snapshot, so a seat it picks may be taken before the
write lands. That is the caller's problem to retry, which keeps the engine pure.

### 5.2 Multi-Leg Atomicity

On round trips each leg gets its own outcome and assignments, but all legs are
allocated and committed in one `CreateHold` transaction. A failed return leg
rolls the outbound allocation back with it, so there is no partial hold to
compensate for and no orphaned hold to leak.

---

## 6. gRPC Interfaces & Contracts

Defined in `libs/contracts/src/proto/inventory.proto`, typed in
`libs/contracts/src/inventory/seat-hold.dto.ts` with the allocation outcomes in
`seat-allocation.dto.ts`. The booking service is the only client, and these RPCs
are never exposed as gateway mutation routes.

### Hold lifecycle

```protobuf
rpc CreateHold  (CreateHoldRequest)  returns (HoldView);
rpc GetHold     (GetHoldRequest)     returns (HoldView);
rpc ReleaseHold (ReleaseHoldRequest) returns (HoldView);
rpc ExtendHold  (ExtendHoldRequest)  returns (HoldView);
```

No client-supplied counts, ranges, TTLs or departure times: inventory resolves
stops, classes, departures and expiry from its own database. `CreateHold` takes
every leg at once and commits them together.

```protobuf
message CreateHoldRequest {
  string bookingKey = 1;
  string ownerId = 2;
  repeated HoldPassengerInput passengers = 3;
  repeated HoldLegInput legs = 4;
}

message HoldView {
  string holdId = 1;
  string bookingKey = 2;
  string ownerId = 3;
  HoldState state = 4;
  int32 version = 5;
  bool extensionUsed = 6;
  string expiresAt = 7;
  string serverNow = 8;
  AllocationOutcome allocationOutcome = 9;
  repeated HoldLegView legs = 10;
  repeated HoldSeatAssignment assignments = 11;
}
```

### Allocation Outcome & Split Notice

```typescript
export enum AllocationOutcome {
  SIDE_BY_SIDE = 'SIDE_BY_SIDE',
  SAME_COACH = 'SAME_COACH',
  SPLIT = 'SPLIT',
}

export const SEATS_SPLIT_NOTICE = {
  code: 'SEATS_SPLIT_NOTICE',
  message: 'تم توزيع المقاعد عبر أكثر من عربة لعدم توفر مقاعد متجاورة كافية',
  messageEn: 'Seats have been split across coaches because consecutive seats were unavailable',
};
```
