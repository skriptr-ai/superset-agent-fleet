// Served only by demo/server.js, before the real application loads.
(() => {
  const params = new URLSearchParams(location.search);
  if (!params.has('at')) {
    params.set('at', '2026-06-15T16:30:00Z');
    history.replaceState(null, '', `${location.pathname}?${params}`);
  }
  let seed = 42;
  Math.random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const demo = {
    paused: params.get('still') === '1',
    at: Date.parse('2026-06-15T16:30:00Z'),
    team: params.get('team') === '1',
  };
  window.fleetDemo = demo;
  const controls = document.createElement('div');
  controls.className = 'demo-controls';
  controls.innerHTML =
    '<span>Demo · fictional sessions</span><button type="button" id="demo-pause"></button>';
  document.querySelector('main').append(controls);
  const button = controls.querySelector('button');
  let elapsed = 12000;
  let started = performance.now();
  demo.clock = () => elapsed + (demo.paused ? 0 : performance.now() - started);
  const label = () => {
    button.textContent = demo.paused ? 'Resume' : 'Pause';
    button.setAttribute('aria-pressed', String(demo.paused));
  };
  button.addEventListener('click', () => {
    elapsed = demo.clock();
    started = performance.now();
    demo.paused = !demo.paused;
    label();
  });
  label();
})();
