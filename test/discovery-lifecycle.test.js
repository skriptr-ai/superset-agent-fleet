import { describe, expect, test } from 'bun:test';

const supersetModule = new URL('../lib/superset.js', import.meta.url).pathname;
const transportModule = new URL('../lib/transport.js', import.meta.url).pathname;

// Every scenario has a fresh module cache. Fixtures replace only the transport, and never
// spawn the real Superset CLI or read a user's state.
async function scenario(body, env = {}) {
  const child = Bun.spawn(
    [
      process.execPath,
      '--no-env-file',
      '--eval',
      `
    import {mock} from 'bun:test';
    const supersetModule=${JSON.stringify(supersetModule)};
    const transportModule=${JSON.stringify(transportModule)};
    ${body}
  `,
    ],
    {
      env: { PATH: process.env.PATH, ...env },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  const output = await new Response(child.stdout).text();
  const errors = await new Response(child.stderr).text();
  expect(await child.exited, errors).toBe(0);
  return JSON.parse(output);
}

const transportDefaults = `hasBackgroundCliCapacity:()=> Number(process.env.AGENT_FLEET_CLI_INFLIGHT ?? 12)>1, callDirectOnly: async()=>({ok:false}), useDirect: async()=>false, transportNote:()=> 'fixture'`;

describe('host identity and discovery lifecycle', () => {
  test('an empty host identity remains provisional until a workspace confirms it', async () => {
    const result = await scenario(`
      let empty=true, localCalls=0;
      mock.module(transportModule,()=>({${transportDefaults},
        call:async()=>{localCalls++;return {ok:true,data:empty?[]:[{id:'ws-a',hostId:'real'}]};},
        runCli:async(args)=>({ok:true,data:args[0]==='status'?{running:true,hostId:'provisional'}:[{id:'real',name:'Fixture Mac'}]})
      }));
      const source=await import(supersetModule);
      const initial=await source.localHostId(); empty=false;
      const confirmed=await source.localHostId();
      const again=await source.localHostId();
      console.log(JSON.stringify({initial,confirmed,again,localCalls}));
    `);
    expect(result).toEqual({
      initial: 'provisional',
      confirmed: 'real',
      again: 'real',
      localCalls: 2,
    });
  });

  test('an unavailable status response cannot establish a local identity', async () => {
    const result = await scenario(`
      mock.module(transportModule,()=>({${transportDefaults},call:async()=>({ok:true,data:[]}),runCli:async()=>({ok:true,data:{running:false,hostId:'wrong'}})}));
      const source=await import(supersetModule);
      console.log(JSON.stringify(await source.localHostId()));
    `);
    expect(result).toBeNull();
  });

  test('malformed successful CLI data is an error instead of an empty successful fleet', async () => {
    const result = await scenario(`
      mock.module(transportModule,()=>({${transportDefaults},call:async()=>({ok:true,data:{renamed:[]}}),runCli:async()=>({ok:true,data:{renamed:[]}})}));
      const source=await import(supersetModule);
      console.log(JSON.stringify(await Promise.all([source.listHosts(),source.listWorkspaces(),source.listTerminals('ws'),source.readTerminal('ws','term')])));
    `);
    expect(
      result.every((entry) => entry.ok === false && entry.error.includes('Unrecognized')),
    ).toBe(true);
  });

  test('fleet discovery reports successful-empty, failed, and offline hosts separately', async () => {
    const result = await scenario(`
      const hosts=[{id:'local',name:'Mac'},{id:'remote',name:'VM'},{id:'offline',online:false,name:'Sleeping'}];
      mock.module(transportModule,()=>({${transportDefaults},
        call:async({cli})=>cli.includes('remote')?{ok:false,error:'timeout'}:{ok:true,data:cli.includes('--host')?[]:[{id:'ws',hostId:'local'}]},
        runCli:async()=>({ok:true,data:hosts})
      }));
      const source=await import(supersetModule); await source.localHostId();
      console.log(JSON.stringify(await source.listWorkspaces()));
    `);
    expect(result.ok).toBe(true);
    expect(result.workspaces).toEqual([]);
    expect(result.authoritativeHostIds).toEqual(['local']);
    expect(result.incompleteHostIds.sort()).toEqual(['offline', 'remote']);
    expect(result.error).toContain('timeout');
  });

  test('a removed host differs from an unavailable host after a complete host list', async () => {
    const result = await scenario(`
      let now=1000,removed=false; Date.now=()=>now;
      mock.module(transportModule,()=>({${transportDefaults},
        call:async({cli})=>{const host=cli.includes('--host')?cli[cli.indexOf('--host')+1]:'A';return removed && host==='B'?{ok:false,error:'timeout'}:{ok:true,data:[{id:'ws-'+host,hostId:host}]};},
        runCli:async()=>({ok:true,data:(removed?['A','B']:['A','B','C']).map(id=>({id,name:id}))})
      }));
      const source=await import(supersetModule);
      await source.listWorkspaces();removed=true;now+=30001;
      console.log(JSON.stringify(await source.listWorkspaces()));
    `);
    expect(result.hostListComplete).toBe(true);
    expect(result.incompleteHostIds).toEqual(['B']);
    expect(result.authoritativeHostIds).toEqual(['A']);
    expect(result.knownWorkspaces.map((ws) => ws.id).sort()).toEqual(['ws-A', 'ws-B']);
  });

  test('global host-list failure differs from an authoritative empty host list', async () => {
    const result = await scenario(`
      let now=1000,mode='initial'; Date.now=()=>now;
      mock.module(transportModule,()=>({${transportDefaults},
        call:async({cli})=>{const host=cli.includes('--host')?cli[cli.indexOf('--host')+1]:'A';return {ok:true,data:[{id:'ws-'+host,hostId:host}]};},
        runCli:async()=>mode==='failed'?{ok:false,error:'cloud unavailable'}:{ok:true,data:mode==='empty'?[]:['A','B'].map(id=>({id,name:id}))}
      }));
      const source=await import(supersetModule);await source.listWorkspaces();
      now+=30001;mode='failed';const failed=await source.listWorkspaces();
      now+=30001;mode='empty';const empty=await source.listWorkspaces();
      console.log(JSON.stringify({failed,empty}));
    `);
    expect(result.failed.hostListComplete).toBe(false);
    expect(result.failed.incompleteHostIds).toEqual(['B']);
    expect(result.empty.hostListComplete).toBe(true);
    expect(result.empty.incompleteHostIds).toEqual([]);
    expect(result.empty.knownWorkspaces.map((ws) => ws.id)).toEqual(['ws-A']);
  });

  test('an expired metadata cache cannot erase a failed local host from completeness', async () => {
    const result = await scenario(`
      let now=1000,failed=false; Date.now=()=>now;
      mock.module(transportModule,()=>({${transportDefaults},
        call:async()=>failed?{ok:false,error:'local unavailable'}:{ok:true,data:[{id:'ws',hostId:'local'}]},
        runCli:async()=>({ok:true,data:failed?[]:[{id:'local',name:'Mac'}]})
      }));
      const source=await import(supersetModule);await source.listWorkspaces();
      now+=300001;failed=true;console.log(JSON.stringify(await source.listWorkspaces()));
    `);
    expect(result.ok).toBe(false);
    expect(result.hostListComplete).toBe(true);
    expect(result.incompleteHostIds).toEqual(['local']);
    expect(result.authoritativeHostIds).toEqual([]);
  });

  test('host discovery returns before a blocked remote read, then includes its metadata', async () => {
    const result = await scenario(`
      let release, remoteReads=0;
      const blocked=new Promise(resolve=>{release=resolve;});
      mock.module(transportModule,()=>({${transportDefaults},
        call:async({cli})=>{if(cli.includes('remote')){remoteReads++;await blocked;return {ok:true,data:[{id:'remote-ws',hostId:'remote'}]};}return {ok:true,data:[{id:'local-ws',hostId:'local'}]};},
        runCli:async()=>({ok:true,data:[{id:'local',name:'Mac'},{id:'remote',name:'VM'}]})
      }));
      const source=await import(supersetModule);
      const first=await source.listWorkspaces({scope:'host'});
      await Promise.resolve(); await Promise.resolve();
      const second=await source.listWorkspaces({scope:'host'});
      release(); await Bun.sleep(1);
      const third=await source.listWorkspaces({scope:'host'});
      console.log(JSON.stringify({first,second,third,remoteReads}));
    `);
    expect(result.first.workspaces.map((ws) => ws.id)).toEqual(['local-ws']);
    expect(result.second.workspaces.map((ws) => ws.id)).toEqual(['local-ws']);
    expect(result.third.knownWorkspaces.map((ws) => ws.id).sort()).toEqual([
      'local-ws',
      'remote-ws',
    ]);
    expect(result.remoteReads).toBe(1);
  });

  test('remote metadata survives a temporary failure but expires after its bounded lifetime', async () => {
    const result = await scenario(`
      let now=1000,remoteOk=true; Date.now=()=>now;
      mock.module(transportModule,()=>({${transportDefaults},
        call:async({cli})=>cli.includes('remote') ? remoteOk ? {ok:true,data:[{id:'remote-ws',hostId:'remote'}]} : {ok:false,error:'offline'} : {ok:true,data:[{id:'local-ws',hostId:'local'}]},
        runCli:async()=>({ok:true,data:[{id:'local',name:'Mac'},{id:'remote',name:'VM'}]})
      }));
      const source=await import(supersetModule);
      await source.listWorkspaces();remoteOk=false;now+=30001;
      const stale=await source.listWorkspaces();now+=300001;
      const expired=await source.listWorkspaces();
      console.log(JSON.stringify({stale,expired}));
    `);
    expect(result.stale.workspaces.map((ws) => ws.id)).toEqual(['local-ws']);
    expect(result.stale.knownWorkspaces.map((ws) => ws.id).sort()).toEqual([
      'local-ws',
      'remote-ws',
    ]);
    expect(result.expired.knownWorkspaces.map((ws) => ws.id)).toEqual(['local-ws']);
    expect(result.expired.incompleteHostIds).toEqual(['remote']);
  });

  test('concurrency one skips remote metadata and name lookups for local scope', async () => {
    const result = await scenario(
      `
      let remoteCalls=0;
      mock.module(transportModule,()=>({${transportDefaults},
        call:async()=>({ok:true,data:[{id:'ws',hostId:'local'}]}),
        runCli:async()=>{remoteCalls++;return {ok:true,data:[]};}
      }));
      const source=await import(supersetModule);await source.localHostId();
      const result=await source.listWorkspaces({scope:'host'});await Bun.sleep(1);
      console.log(JSON.stringify({remoteCalls,rooms:result.workspaces.length}));
    `,
      { AGENT_FLEET_CLI_INFLIGHT: '1' },
    );
    expect(result).toEqual({ remoteCalls: 0, rooms: 1 });
  });

  test('host-scope cloud name and metadata calls use only the background budget', async () => {
    const result = await scenario(`
      const priorities=[];
      mock.module(transportModule,()=>({${transportDefaults},
        call:async({cli,background})=>{if(cli.includes('remote')) priorities.push(background);return {ok:true,data:[{id:'ws',hostId:'local'}]};},
        runCli:async(args,options)=>{priorities.push(options?.background);return {ok:true,data:[{id:'local'},{id:'remote'}]};}
      }));
      const source=await import(supersetModule);await source.localHostId();
      await source.listWorkspaces({scope:'host'});await Bun.sleep(1);
      console.log(JSON.stringify(priorities));
    `);
    expect(result).toEqual([true, true]);
  });

  test('host identity and rooms do not await an unavailable cloud host list', async () => {
    const result = await scenario(`
      let requests=0;
      mock.module(transportModule,()=>({${transportDefaults},call:async()=>({ok:true,data:[{id:'local-ws',hostId:'local'}]}),runCli:async()=>{requests++;return new Promise(()=>{});}}));
      const source=await import(supersetModule);
      const id=await source.localHostId();
      const rooms=await source.listWorkspaces({scope:'host'});
      console.log(JSON.stringify({id,rooms:rooms.workspaces.length,requests}));
    `);
    expect(result).toEqual({ id: 'local', rooms: 1, requests: 1 });
  });
});
