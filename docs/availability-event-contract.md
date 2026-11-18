# Seat Availability Changed Event

## Event name

`inventory.seat.availability-changed`

## Published by

Inventory, through the outbox, in the same transaction as the seat change that
caused it. A trip whose seats were committed but whose counts were never
announced is not a state the two services can reach.

## Consumed by

Catalog, on the `catalog.invalidation.seat-availability-changed` queue.

## Fields

Carried by the envelope:

- `id` — unique per event; the inbox uses it to ignore duplicates.
- `occurredAt` — when the change happened, for lag measurement.
- `version` — payload schema version, not the trip's version.
- `correlationId` — the publication or hold that caused the change.

Carried by the payload, one event per affected segment and class:

- `tripId`
- `originStationId`, `destinationStationId` — named by station, not stop
  position, so catalog needs no copy of inventory's stop table.
- `travelClassId`
- `availableSeats` — the new count for that segment and class.

## Decision

One event per (trip, origin, destination, class), carrying the new count.

Catalog's invalidation consumer already owned this payload shape before
inventory had a producer; it drops exactly the cache key that went stale. The
count travels with the event so a future consumer can warm the key instead of
dropping it, without a second contract.

The granularity matters for what this event is for: a republication can change
the seat picture underneath counts catalog has already cached, and nothing else
invalidates them — hold events advance catalog's per-trip availability
generation, publication does not.

## Trade-off

**Cost:** inventory counts every overlapping segment before publishing, which
is `O(stops²) × classes` rows for a whole-trip change, and emits one event per
row. They are appended as a single outbox batch so the relay sees one write.

**Benefit:** catalog invalidates precisely what changed and never has to call
inventory to find out what a change meant.

**Rejected: one event per trip carrying a `counts` array plus an authoritative
`availability_version` column in inventory, written through to Redis under a
"save if newer" guard.** Fewer, larger events, and reads served without a
recompute. It was rejected because catalog already tracks a per-trip
availability generation in Redis, bumped by hold events, and the version column
would have been a second source of truth for the same number — with the two
disagreeing whenever only one of them moved. If write-through is wanted later,
it replaces the generation counter rather than sitting beside it.

**Rejected: an event that only says "this trip changed".** Smaller, but catalog
would call inventory after every event, adding load and a new failure path.
