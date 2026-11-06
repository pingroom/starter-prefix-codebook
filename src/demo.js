import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { step, exportProposal, exportAnalysis, codec } from './engine.js';
import { readJson } from './storage.js';
import { mockApi, CONFIG, ROOM_CODE } from './mock.js';

const input = await readJson(new URL('../examples/alphabet.json', import.meta.url));
const sequence = await readJson(new URL('../examples/symbols.json', import.meta.url));
for (const scenario of [
  { title: 'Observed counts produce a codebook and local round trip', counts: ['2','3','5','20'], status:'complete', cost:'45' },
  { title: 'Equal counts use the declared ID tie policy', counts: ['1','1','1','1'], status:'complete', cost:'8' },
  { title: 'Zero-count events remain encodable', counts: ['0','0','0','9'], status:'complete', cost:'9' },
  { title: 'All-zero observations produce a negative audit', counts: ['0','0','0','0'], status:'complete' },
  { title: 'Unknown observations withhold the codebook', counts: ['Unknown','3','5','20'], status:'incomplete' },
]) {
  const directory=await mkdtemp(join(tmpdir(),'pingroom-codebook-demo-'));
  try {
    const now=()=>'2026-01-01T09:00:00.000Z',api=mockApi(now);
    const options={client:api.client,directory,input,config:CONFIG,token:'offline-fixture-token',room:ROOM_CODE,now};
    let result,packet=null;
    for(const count of scenario.counts) {result=await step(options);api.answer(result.answers.find(answer=>answer.status==='pending').questionId,count);result=await step(options);}
    assert.equal(result.status,scenario.status);
    if(scenario.cost) {
      assert.equal(result.analysis.weightedBits,scenario.cost);assert.deepEqual(await exportProposal(directory,input),result.proposal);
      packet=await codec(directory,input,'encode',sequence);assert.deepEqual(await codec(directory,input,'decode',packet),sequence);
    } else {assert.equal(result.proposal,null);await assert.rejects(exportProposal(directory,input));await assert.rejects(codec(directory,input,'encode',sequence));}
    if(result.status==='complete')await exportAnalysis(directory,input);else await assert.rejects(exportAnalysis(directory,input));
    console.log(JSON.stringify({scenario:scenario.title,status:result.status,analysis:result.analysis,packet},null,2));
  } finally {await rm(directory,{recursive:true,force:true});}
}
console.log('Offline demo used the pinned SDK and local mock transport. No live phone delivery or external action.');
