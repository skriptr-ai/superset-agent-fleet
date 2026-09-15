import { describe, expect, test } from 'bun:test';

const transportModule = new URL('../lib/transport.js', import.meta.url).pathname;
const manifestModule = new URL('../lib/manifest.js', import.meta.url).pathname;

async function scenario(body) {
  const child = Bun.spawn(
    [
      process.execPath,
      '--no-env-file',
      '--eval',
      `
    import {mock} from 'bun:test';
    let now=1000; Date.now=()=>now;
    const transportModule=${JSON.stringify(transportModule)};
    const manifestModule=${JSON.stringify(manifestModule)};
    const envelope=(value)=>Response.json({result:{data:{json:value}}});
    ${body}
  `,
    ],
    { env: { PATH: process.env.PATH }, stdout: 'pipe', stderr: 'pipe' },
  );
  const output = await new Response(child.stdout).text();
  const errors = await new Response(child.stderr).text();
  expect(await child.exited, errors).toBe(0);
  return JSON.parse(output);
}

describe('private transport recovery', () => {
  test('a missing host is retried once after cooldown and concurrent probes are shared', async () => {
    const result = await scenario(`
      let available=false,reads=0,requests=0;
      mock.module(manifestModule,()=>({readHostManifest:async()=>{reads++;return available?{manifest:{endpoint:'http://127.0.0.1:9999',authToken:'fixture'}}:{manifest:null,reason:'absent'};}}));
      globalThis.fetch=async()=>{requests++;return envelope([]);};
      const source=await import(transportModule);
      const initial=await source.useDirect();available=true;
      const early=await source.useDirect();now+=5000;
      const recovered=await Promise.all(Array.from({length:12},()=>source.useDirect()));
      console.log(JSON.stringify({initial,early,recovered,reads,requests}));
    `);
    expect(result.initial).toBe(false);
    expect(result.early).toBe(false);
    expect(result.recovered.every(Boolean)).toBe(true);
    expect(result.reads).toBe(2);
    expect(result.requests).toBe(1);
  });

  test('a rotated token is reread and an unsupported optional procedure has a separate cooldown', async () => {
    const result = await scenario(`
      let token='old',reads=0,requests=0,optional=0;
      mock.module(manifestModule,()=>({readHostManifest:async()=>{reads++;return {manifest:{endpoint:'http://127.0.0.1:9999',authToken:token}};}}));
      globalThis.fetch=async(url,options)=>{
        requests++;
        if(options.headers.authorization!=='Bearer '+token)return new Response('',{status:401});
        if(url.includes('terminalAgents.list')){optional++;return new Response('',{status:404});}
        return envelope(url.includes('workspace.list')?[]:{text:'fixture'});
      };
      const source=await import(transportModule);await source.useDirect();token='new';
      const failed=await source.callDirectOnly('terminal.snapshot',{});
      const early=await source.useDirect();now+=5000;
      const recovered=await source.useDirect();
      await source.callDirectOnly('terminalAgents.list',undefined);
      await source.callDirectOnly('terminalAgents.list',undefined);
      const stillDirect=await source.useDirect();
      const screen=await source.callDirectOnly('terminal.snapshot',{});
      console.log(JSON.stringify({failed:failed.ok,early,recovered,stillDirect,screen:screen.ok,reads,optional}));
    `);
    expect(result).toEqual({
      failed: false,
      early: false,
      recovered: true,
      stillDirect: true,
      screen: true,
      reads: 2,
      optional: 1,
    });
  });
});
