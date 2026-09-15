// Fictional fixtures only. This module never reads Superset or the local machine.
export const DEMO_AT = Date.parse('2026-06-15T16:30:00Z');

const jobs = [
  [
    'captain',
    'Launch captain',
    'working',
    'claude',
    'Coordinate the new recipe finder',
    'reviewing',
    'Reviewing the search and recipe changes',
  ],
  [
    'search',
    'Recipe search',
    'working',
    'codex',
    'Find recipes by ingredients already in the pantry',
    'implementing',
    'Adding ingredient filters',
  ],
  [
    'cards',
    'Recipe cards',
    'working',
    'claude',
    'Make recipe cards easier to scan',
    'testing',
    'Checking the mobile layout',
  ],
  [
    'accessibility',
    'Keyboard navigation',
    'working',
    'codex',
    'Make every recipe reachable with a keyboard',
    'testing',
    'Testing keyboard focus',
  ],
  [
    'planner',
    'Meal planner',
    'working',
    'claude',
    'Build a weekly meal planner',
    'implementing',
    'Saving the weekly menu',
  ],
  [
    'shopping',
    'Shopping list',
    'waiting',
    'codex',
    'Group ingredients into a shopping list',
    'thinking',
    'Ready for your review',
  ],
  [
    'docs',
    'Getting started',
    'idle',
    'claude',
    'Write the first-run guide',
    'thinking',
    'The guide is ready',
  ],
  [
    'icons',
    'Pantry icons',
    'idle',
    'codex',
    'Draw icons for the pantry',
    'thinking',
    'The icons are ready',
  ],
];

export function demoWorld({ team = false, tick = 1, pins = [] } = {}) {
  const people = team ? ['Alex', 'Sam', 'Jules'] : ['Alex'];
  const agents = [];
  const links = [];
  const events = [];
  const hubIds = [];
  for (const owner of people) {
    const prefix = owner.toLowerCase();
    const hub = `${prefix}-captain`;
    hubIds.push(hub);
    for (const [index, [key, name, status, flavor, title, phase, detail]] of jobs.entries()) {
      const id = `${prefix}-${key}`;
      agents.push({
        id,
        name,
        owner,
        status,
        flavor,
        type: 'workspace',
        project: 'Tiny Kitchen',
        branch: `feature/${key}`,
        hostName: `${prefix}-laptop`,
        remote: false,
        tags: index < 4 ? ['Recipe launch'] : [],
        task: { title, source: 'session' },
        doing: {
          phase,
          label: phase,
          detail,
          source: 'transcript',
          story: ['researched', 'planned'],
        },
        activity: detail,
        says: detail,
        queued: [],
        leadTerminalId: `${id}-terminal`,
        terminals: [
          {
            id: `${id}-terminal`,
            screen: `${name}\n\n${title}\n\n${detail}.\n\nFictional demo session.`,
          },
        ],
      });
      if (index > 0 && index < 4) {
        links.push({
          fromId: hub,
          toId: id,
          sends: 3,
          reads: 1,
          replies: 2,
          lastAt: DEMO_AT - index * 1000,
          lastKind: 'send',
        });
        events.push(
          {
            id: `${id}-brief`,
            kind: 'send',
            fromId: hub,
            toId: id,
            at: DEMO_AT - 120000,
            text: `${title}. Keep the change focused and check it with the sample recipes.`,
          },
          {
            id: `${id}-reply`,
            kind: 'report',
            fromId: id,
            toId: hub,
            at: DEMO_AT - 60000,
            text:
              key === 'search'
                ? 'Ingredient filters are in place. You can now find dinner using what is already in the pantry. I am checking empty results and combined filters.'
                : `${detail}. The sample recipes look good so far.`,
          },
          {
            id: `${id}-followup`,
            kind: 'send',
            fromId: hub,
            toId: id,
            at: DEMO_AT - 20000,
            text:
              key === 'search'
                ? 'Lovely. Make the empty state suggest removing one ingredient, then send the results.'
                : 'Check the smallest screen size too, then send the results.',
          },
        );
      } else if (index > 0) {
        events.push({
          id: `${id}-request`,
          kind: 'send',
          fromId: null,
          toId: id,
          at: DEMO_AT - 90000,
          text: title,
        });
      }
    }
    if (tick > 1) {
      const reply = tick % 2 === 0;
      events.push({
        id: `${prefix}-live-${tick}`,
        kind: reply ? 'report' : 'send',
        fromId: reply ? `${prefix}-search` : hub,
        toId: reply ? hub : `${prefix}-search`,
        at: DEMO_AT + tick * 5000,
        text: reply
          ? 'The ingredient filters pass. Checking one last recipe.'
          : 'Try the pantry with just tomatoes and pasta.',
      });
    }
  }
  return {
    tick,
    at: DEMO_AT,
    demo: true,
    owner: 'Alex',
    hostName: 'alex-laptop',
    agents,
    links,
    events,
    hubIds: [...new Set([...hubIds, ...pins])],
    pins,
    error: null,
  };
}

export const demoWeather = {
  place: { name: 'Oslo', tz: 'Europe/Oslo', lat: 59.9139, lon: 10.7522 },
  weather: {
    at: new Date(DEMO_AT).toISOString(),
    symbol: 'fair',
    kind: null,
    intensity: 0,
    cloud: 0.15,
    fog: false,
    thunder: false,
    temperature: 21,
    wind: 2,
  },
  error: null,
};
