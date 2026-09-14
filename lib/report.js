// How a machine tells the cloud about itself.
//
// The public view (api/) cannot read a terminal; this is the other half of it. After every
// poll the server hands the snapshot here, and it goes up to /api/push with this machine's
// key. What comes back is the cloud's pins — a session somebody put behind the bar from the
// public page — and whether anybody is watching, which is what lets the host poll fast only
// when there is someone to poll for.
//
// A poll whose world did not change is a heartbeat, not a report: the clock moves but nothing
// is stored, so an idle machine costs the store nothing. Failures are kept and shown, never
// thrown: reporting is a courtesy to the cloud, not a condition of drawing the local page.

const TIMEOUT_MS = 8_000;

export class Reporter {
  #url;
  #key;
  #host;
  #world;
  #fingerprint = '';
  #inflight = null;
  /** @type {number} how many pages the cloud says are open on the world */
  watchers = 0;
  /** Why the last report failed, or null. */
  error = null;
  /** When the cloud last accepted a report, in ms since epoch, or 0. */
  lastOkAt = 0;
  /** Pins made on THIS machine's page since the last report, to be told to the cloud. */
  #pinChanges = [];

  constructor({ url, key, hostName, world }) {
    this.#url = url;
    this.#key = key;
    this.#host = hostName;
    this.#world = world;
  }

  get enabled() {
    return Boolean(this.#url && this.#key && this.#host);
  }

  /** Whether anyone is watching through the cloud, as of the last report. */
  get watched() {
    return this.watchers > 0 && Date.now() - this.lastOkAt < 60_000;
  }

  /** A pin made here goes up with the next report, so the cloud's set does not undo it. */
  pin(id, on) {
    this.#pinChanges = this.#pinChanges.filter((c) => c.id !== id);
    this.#pinChanges.push({ id, pinned: Boolean(on) });
  }

  /** Report a snapshot. Overlapping reports are dropped rather than queued: the next is newer. */
  async report(snapshot) {
    if (!this.enabled || this.#inflight) return;
    this.#inflight = this.#send(snapshot).finally(() => {
      this.#inflight = null;
    });
    await this.#inflight;
  }

  async #send(snapshot) {
    const { events = [], ...rest } = snapshot;
    // What the picture is made of, minus the clocks, so an unchanged world is recognised.
    const print = JSON.stringify([rest.agents, rest.links, rest.hubIds, rest.pins, rest.error]);
    const heartbeat = !events.length && print === this.#fingerprint;
    const pinChanges = this.#pinChanges;
    this.#pinChanges = [];
    const body = heartbeat
      ? { hostName: this.#host, heartbeat: true, pinChanges }
      : { hostName: this.#host, snapshot: rest, events, pins: rest.pins ?? [], pinChanges };
    try {
      const res = await fetch(this.#url, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.#key}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const answer = await res.json().catch(() => ({}));
      if (!res.ok || !answer.ok) {
        this.error = answer.error ?? `cloud answered ${res.status}`;
        return;
      }
      this.#fingerprint = print;
      this.error = null;
      this.lastOkAt = Date.now();
      this.watchers = Number(answer.watchers) || 0;
      this.#applyPins(answer.pins);
    } catch (err) {
      this.error = err.message;
      // Not delivered: say them again next time.
      this.#pinChanges = [...pinChanges, ...this.#pinChanges];
    }
  }

  /** Make this machine's pins the cloud's. A pin that changed here re-runs the election. */
  #applyPins(pins) {
    if (!Array.isArray(pins)) return;
    const wanted = new Set(pins.filter((p) => typeof p === 'string'));
    let changed = false;
    for (const id of wanted)
      if (!this.#world.pins.has(id)) changed = this.#world.pin(id, true) || changed;
    for (const id of [...this.#world.pins])
      if (!wanted.has(id)) changed = this.#world.pin(id, false) || changed;
    if (changed) this.onPinsChanged?.();
  }
}
