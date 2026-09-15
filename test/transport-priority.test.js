import { expect, test } from 'bun:test';

const transportModule = new URL('../lib/transport.js', import.meta.url).pathname;

// Exercise the real process limiter with Bun fixture children. Their background requests
// wait on a loopback test gate, so correctness depends on ordering rather than elapsed time.
test('background CLI work reserves foreground capacity under the total process limit', async () => {
  const child = Bun.spawn(
    [
      process.execPath,
      '--no-env-file',
      '--eval',
      `
    const {runCli}=await import(${JSON.stringify(transportModule)});
    let release,started,active=0,maxActive=0;
    const gate=new Promise(resolve=>{release=resolve;});
    const backgroundStarted=new Promise(resolve=>{started=resolve;});
    const requests=[];
    const server=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(request){
      const name=new URL(request.url).pathname.slice(1);
      requests.push(name);active++;maxActive=Math.max(maxActive,active);
      if(name.startsWith('background')) {if(name==='background1') started(); await gate;}
      active--;return new Response('ok');
    }});
    const command=(name)=>['--eval','await fetch('+JSON.stringify(new URL(name,server.url).href)+');console.log(JSON.stringify({done:true}))','--'];
    let timer;
    try {
      const first=runCli(command('background1'),{background:true});
      await backgroundStarted;
      const second=runCli(command('background2'),{background:true});
      const foreground=runCli(command('foreground'));
      const completed=await Promise.race([foreground.then(result=>result.ok),new Promise(resolve=>{timer=setTimeout(()=>resolve(false),3000);})]);
      clearTimeout(timer);
      const beforeRelease=[...requests];
      release();
      const results=await Promise.all([first,second,foreground]);
      console.log(JSON.stringify({completed,beforeRelease,maxActive,allOk:results.every(result=>result.ok)}));
    } finally {clearTimeout(timer);release();server.stop(true);}
  `,
    ],
    {
      env: {
        PATH: process.env.PATH,
        SUPERSET_CLI: process.execPath,
        AGENT_FLEET_CLI_INFLIGHT: '2',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  const output = await new Response(child.stdout).text();
  const errors = await new Response(child.stderr).text();
  expect(await child.exited, errors).toBe(0);
  const result = JSON.parse(output);
  expect(result.completed).toBe(true);
  expect(result.beforeRelease).toEqual(['background1', 'foreground']);
  expect(result.maxActive).toBeLessThanOrEqual(2);
  expect(result.allOk).toBe(true);
}, 10000);

test('concurrency one rejects background CLI work instead of occupying the foreground slot', async () => {
  const child = Bun.spawn(
    [
      process.execPath,
      '--no-env-file',
      '--eval',
      `
    const {runCli}=await import(${JSON.stringify(transportModule)});
    const result=await runCli(['--eval','throw new Error("must not spawn")','--'],{background:true});
    console.log(JSON.stringify(result));
  `,
    ],
    {
      env: {
        PATH: process.env.PATH,
        SUPERSET_CLI: process.execPath,
        AGENT_FLEET_CLI_INFLIGHT: '1',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  const output = await new Response(child.stdout).text();
  expect(await child.exited).toBe(0);
  expect(JSON.parse(output)).toEqual({
    ok: false,
    error: 'Background CLI discovery disabled at concurrency 1',
  });
});
