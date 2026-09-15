// Keep one plan for the current camera view. Exact coordinates avoid stale geometry while moving.
export class ViewCache {
  read(identity, view, build) {
    const same =
      this.identity === identity &&
      this.view &&
      ['x0', 'y0', 'x1', 'y1', 'zoom'].every((key) => this.view[key] === view[key]);
    if (!same) {
      this.value = build();
      this.identity = identity;
      this.view = { ...view };
    }
    return this.value;
  }
}
