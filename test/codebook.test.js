import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { step, localReport, exportProposal, exportAnalysis, codec } from '../src/engine.js';
import { readJson, atomicJson, acquireLock, atomicText } from '../src/storage.js';
import { validateInput, validateState, tasksFor, parseCount, prefixCodebook, huffman, validateCodebook, encode, decode, MAX_COUNT, MAX_SYMBOLS, MAX_BITS, POLICY, POLICY_HASH, TOKEN, requestFor, validateConfig, hash, iso, isId, ROOM } from '../src/model.js';
import { loadConnection, loadEnvironment, validateConnection } from '../src/config.js';
import { makeClient } from '../src/client.js';
import { mockApi, CONFIG, ROOM_CODE, OTHER, ASKER, id } from '../src/mock.js';

const example = await readJson(new URL('../examples/alphabet.json', import.meta.url), 65536);
const simple = () => structuredClone(example);
const twoItems = () => structuredClone(example);
async function setup(t, input = simple()) {
  const directory = await mkdtemp(join(tmpdir(), 'pingroom-codebook-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const clock = { value: '2026-01-01T09:00:00.000Z' }, now = () => clock.value;
  const api = mockApi(now);
  const options = { client: api.client, directory, input, config: structuredClone(CONFIG), token: 'offline-fixture-token', room: ROOM_CODE, now };
  return { directory, clock, api, options, run: (extra = {}) => step({ ...options, ...extra }), saved: () => readJson(join(directory, 'state.json')) };
}
const sends = (api) => api.calls.filter((call) => call.method === 'POST').length;
async function decide(s, decisions) {
  let result;
  for (const value of decisions) {
    result = await s.run();
    const pending = result.answers.find(item => item.status === 'pending');
    s.api.answer(pending.questionId, value); result = await s.run();
  }
  return result;
}

test('lost response blocks later counts; exact-ID recovery reads the original request without resend', async (t) => {
  const s = await setup(t, twoItems()); s.api.controls.loseNext = true;
  assert.equal((await s.run()).status, 'create_unknown'); assert.equal((await s.run()).status, 'create_unknown');
  assert.deepEqual((await s.run({ command: 'find' })).candidates, [{ id: id(1), state: 'pending' }]);
  s.api.answer(id(1), '5'); assert.equal((await s.run({ command: 'recover', attachId: id(1) })).status, 'ready');
  assert.equal(sends(s.api), 1);
});

test('malformed create response and empty search never authorize a new POST', async (t) => {
  const s = await setup(t); s.api.controls.malformedNext = true; await assert.rejects(s.run());
  assert.equal((await s.saved()).attempts[0].status, 'creating'); s.api.questions.clear();
  assert.deepEqual((await s.run({ command: 'find' })).candidates, []);
  assert.equal((await s.run()).status, 'create_unknown'); assert.equal(sends(s.api), 1);
});

test('recovery validates exact target, room, request, options, data and non-handoff provenance', async (t) => {
  for (const mutate of [
    (q) => { q.target_user_id = OTHER; }, (q) => { q.room.code = 'WRONG1234567'; }, (q) => { q.prompt = 'Other prompt'; },
    (q) => { q.options = [{value:'yes',label:'Yes'}]; }, (q) => { q.text_input.max_length = 30; }, (q) => { q.text_input = null; },
    (q) => { q.data.task_id = 'other'; }, (q) => { q.data.input_hash = 'changed'; }, (q) => { delete q.is_handoff; },
    (q) => { q.is_handoff = true; }, (q) => { q.asker.type = 'user'; }, (q) => { q.resolution_policy = 'all'; },
  ]) {
    const s = await setup(t); s.api.controls.loseNext = true; await s.run(); mutate(s.api.questions.get(id(1)));
    await assert.rejects(s.run({ command: 'recover', attachId: id(1) })); assert.equal((await s.saved()).attempts[0].status, 'creating');
    assert.equal(sends(s.api), 1);
  }
});

test('misattributed, malformed or non-text answers never resolve a count', async (t) => {
  for (const mutate of [
    (q) => { q.answer.responder.id = OTHER; }, (q) => { q.answer.responder = null; },
    (q) => { q.answer.text = '1e2'; }, (q) => { q.answer.value = 'unsupported'; }, (q) => { q.answer.label = 'Wrong'; },
  ]) {
    const s = await setup(t); await s.run(); s.api.answer(id(1), '5'); mutate(s.api.questions.get(id(1)));
    const result = await s.run(); assert.equal(result.observedStatus, 'invalid_answer'); assert.equal(result.proposal, null);
    assert.equal(sends(s.api), 1);
  }
});

test('original asker, lifetime and intent remain bound across reads and across counts', async (t) => {
  for (const mutate of [
    (q) => { q.asker.id = OTHER; },
    (q) => { q.created_at = '2026-01-01T09:00:01.000Z'; q.expires_at = '2026-01-01T09:15:01.000Z'; },
  ]) {
    const s = await setup(t); await s.run(); mutate(s.api.questions.get(id(1))); await assert.rejects(s.run(), /identity or lifetime/);
  }
  const s = await setup(t, twoItems()); await s.run(); s.api.answer(id(1), '5'); await s.run();
  s.api.controls.loseNext = true; await s.run(); s.api.questions.get(id(2)).asker.id = OTHER;
  await assert.rejects(s.run({ command: 'recover', attachId: id(2) }), /different asking registrations/);
  const other = await setup(t); other.api.controls.loseNext = true; await other.run();
  const q = other.api.questions.get(id(1)); q.created_at = '2026-01-01T08:58:59.000Z'; q.expires_at = '2026-01-01T09:13:59.000Z';
  await assert.rejects(other.run({ command: 'recover', attachId: id(1) }), /predates/);
});

test('expiry accepts delayed processing but rejects premature and implausibly future resolution on replay', async (t) => {
  const s = await setup(t); await s.run(); s.clock.value = '2026-01-01T09:16:00.000Z';
  s.api.terminal(id(1), 'expired'); s.api.questions.get(id(1)).resolved_at = '2026-01-01T09:15:30.000Z';
  assert.equal((await s.run()).observedStatus, 'expired'); assert.equal((await localReport(s.directory, s.options.input)).proposal, null);
  const original = await s.saved();
  for (const timestamp of ['2026-01-01T09:14:59.999Z', '2026-01-01T09:17:00.001Z']) {
    const saved = structuredClone(original); saved.attempts[0].observation.resolvedAt = timestamp;
    await atomicJson(s.directory, 'state.json', saved); const calls = s.api.calls.length;
    await assert.rejects(s.run(), /resolution time/); assert.equal(s.api.calls.length, calls);
    const live = await setup(t); await live.run(); live.clock.value = s.clock.value; live.api.terminal(id(1), 'expired');
    live.api.questions.get(id(1)).resolved_at = timestamp; await assert.rejects(live.run(), /resolution time/);
  }
});

test('answer and resolution times must agree and answer/cancellation cannot occur after expiry', async (t) => {
  const s = await setup(t); await s.run(); s.api.answer(id(1), '5');
  s.api.questions.get(id(1)).answer.answered_at = '2026-01-01T09:00:01.000Z';
  assert.equal((await s.run()).observedStatus, 'invalid_answer');
  for (const terminal of ['answered', 'cancelled']) {
    const other = await setup(t); await other.run(); other.clock.value = '2026-01-01T09:16:00.000Z';
    if (terminal === 'answered') other.api.answer(id(1), '5'); else other.api.terminal(id(1), terminal);
    await assert.rejects(other.run(), /resolution time/);
  }
});

test('checked time follows response; future creation, wrong TTL and answer on pending fail', async (t) => {
  const s = await setup(t); await s.run(); const get = s.api.client.questions.get.bind(s.api.client.questions);
  s.api.client.questions.get = async (...args) => { s.clock.value = '2026-01-01T09:02:00.000Z'; s.api.answer(id(1), '5'); return get(...args); };
  await s.run(); assert.equal((await s.saved()).attempts[0].observation.checkedAt, s.clock.value);
  for (const mutate of [
    (q) => { q.created_at = '2027-01-01T09:00:00.000Z'; q.expires_at = '2027-01-01T09:15:00.000Z'; },
    (q) => { q.expires_at = '2026-01-01T10:00:00.000Z'; }, (q) => { q.answer = {}; },
  ]) { const other = await setup(t); await other.run(); mutate(other.api.questions.get(id(1))); await assert.rejects(other.run()); }
  assert.equal(iso('2026-01-01T09:00:00+00:00'), '2026-01-01T09:00:00.000Z'); assert.throws(() => iso('2026-02-30T09:00:00Z'));
});

test('room preflight refuses public/unsupported rooms and missing operator before a POST', async (t) => {
  for (const mutate of [(rooms) => { rooms[0].is_public = true; }, (rooms) => { rooms[0].type = 'dm'; }, (rooms) => { rooms[0].members = [{ user_id: OTHER }]; }]) {
    const s = await setup(t); mutate(s.api.rooms); await assert.rejects(s.run()); assert.equal(sends(s.api), 0);
  }
});

test('reservation write failure sends nothing; answer save failure resumes the original question', async (t) => {
  const s = await setup(t); let writes = 0;
  await assert.rejects(s.run({ write: async (...args) => { if (++writes === 2) throw new Error('disk full'); await atomicJson(...args); } }), /disk full/);
  assert.equal(sends(s.api), 0); await s.run(); s.api.answer(id(1), '5');
  await assert.rejects(s.run({ write: async () => { throw new Error('disk full'); } }), /disk full/);
  assert.equal((await s.saved()).attempts[0].status, 'pending'); assert.equal((await s.run()).status, 'ready'); assert.equal(sends(s.api), 1);
});

test('post-create save failure leaves uncertain intent for verified recovery without another POST', async (t) => {
  const s = await setup(t); let writes = 0;
  await assert.rejects(s.run({ write: async (...args) => { if (++writes === 3) throw new Error('disk full'); await atomicJson(...args); } }), /disk full/);
  assert.equal((await s.run()).status, 'create_unknown');
  assert.equal((await s.run({ command: 'recover', attachId: id(1) })).status, 'pending'); assert.equal(sends(s.api), 1);
});

test('failed reads preserve evidence and corrupted request/provenance fail before network', async (t) => {
  const s = await setup(t); await s.run(); const before = await readFile(join(s.directory, 'state.json'), 'utf8');
  s.api.controls.readError = true; await assert.rejects(s.run()); assert.equal(await readFile(join(s.directory, 'state.json'), 'utf8'), before);
  s.api.controls.readError = false; s.api.answer(id(1), '5'); await s.run(); const original = await s.saved();
  for (const mutate of [
    (saved) => { saved.attempts[0].request.ttl = 60; }, (saved) => { saved.attempts.push(saved.attempts[0]); },
    (saved) => { saved.attempts[0].pair = 'other::pair'; }, (saved) => { saved.attempts[0].observation.answer.responderId = OTHER; },
  ]) {
    const saved = structuredClone(original); mutate(saved); assert.throws(() => validateState(saved, s.options.input));
    await atomicJson(s.directory, 'state.json', saved); const calls = s.api.calls.length;
    await assert.rejects(s.run()); assert.equal(s.api.calls.length, calls);
  }
});

test('bounded file reads reject malformed, oversized, invalid UTF-8 and symlink data without revealing contents', async (t) => {
  const s = await setup(t), path = join(s.directory, 'bad.json');
  await writeFile(path, '{"secret":"PRIVATE_TOKEN",bad');
  await assert.rejects(readJson(path), (error) => !error.message.includes('PRIVATE_TOKEN') && error.message.includes('malformed'));
  await writeFile(path, Buffer.from([0xff])); await assert.rejects(readJson(path), /UTF-8/);
  await writeFile(path, 'x'.repeat(100)); await assert.rejects(readJson(path, 50), /size limit/);
  await symlink(path, join(s.directory, 'linked')); await assert.rejects(readJson(join(s.directory, 'linked')));
});

test('private lock excludes other commands; report is offline and private', async (t) => {
  const s = await setup(t); await s.run(); const release = await acquireLock(s.directory);
  await assert.rejects(s.run(), /lock exists/); await assert.rejects(localReport(s.directory, s.options.input), /lock exists/);
  await release(); const before = s.api.calls.length;
  assert.equal((await localReport(s.directory, s.options.input, { save: true })).proposal, null); assert.equal(s.api.calls.length, before);
  assert.equal((await stat(join(s.directory, 'report.json'))).mode & 0o777, 0o600);
});

test('partial or blank environment overrides never combine with saved credentials', async (t) => {
  const s = await setup(t); await atomicJson(s.directory, 'credentials.json', { token: 'saved', room: ROOM_CODE });
  await assert.rejects(loadConnection(s.directory, { PINGROOM_TOKEN: '' })); await assert.rejects(loadConnection(s.directory, { PINGROOM_ROOM: ROOM_CODE }));
  assert.equal((await loadConnection(s.directory, { PINGROOM_TOKEN: 'explicit', PINGROOM_ROOM: ROOM_CODE.toLowerCase() })).token, 'explicit');
});

test('transport rejects unrelated writes, redirects and oversized responses', async () => {
  let count = 0; const client = makeClient({ token: 'fixture', fetchImpl: async () => { count++; return new Response(null, { status: 302 }); } });
  await assert.rejects(client.questions.get(id(1))); assert.equal(count, 1); await assert.rejects(client.questions.cancel(id(1))); assert.equal(count, 1);
  const large = makeClient({ token: 'fixture', fetchImpl: async () => new Response('x'.repeat(512 * 1024 + 1)) }); await assert.rejects(large.questions.get(id(1)));
});

test('transport deadlines bound stalled fetch/body and allow abort through infinite ready empty chunks', async () => {
  const stalled = makeClient({ token: 'fixture', deadlineMs: 20, fetchImpl: () => new Promise(() => {}) }); await assert.rejects(stalled.questions.get(id(1)));
  const body = makeClient({ token: 'fixture', deadlineMs: 20, fetchImpl: async () => new Response(new ReadableStream({ pull: () => new Promise(() => {}) })) }); await assert.rejects(body.questions.get(id(1)));
  const controller = new AbortController();
  const empty = makeClient({ token: 'fixture', signal: controller.signal, fetchImpl: async () => new Response(new ReadableStream({ pull: (out) => out.enqueue(new Uint8Array()) })) });
  const timer = setTimeout(() => controller.abort(), 20); try { await assert.rejects(empty.questions.get(id(1))); } finally { clearTimeout(timer); }
});

test('abort before reservation sends nothing; after reservation it preserves unresolved intent', async (t) => {
  const s = await setup(t), stopped = new AbortController(); stopped.abort(); await assert.rejects(s.run({ signal: stopped.signal })); assert.equal(sends(s.api), 0);
  const controller = new AbortController(); let writes = 0;
  await assert.rejects(s.run({ signal: controller.signal, write: async (...args) => { await atomicJson(...args); if (++writes === 2) controller.abort(); } }));
  assert.equal(sends(s.api), 0); assert.equal((await s.run()).status, 'create_unknown');
});


test('partial external credentials cannot borrow the room from dotenv', async (t) => {
  const s = await setup(t), path = join(s.directory, '.env');
  await writeFile(path, 'PINGROOM_TOKEN=file-token\nPINGROOM_ROOM=DEMO12345678\n');
  const partial = { PINGROOM_TOKEN: 'shell-token' }; await loadEnvironment(partial, path);
  assert.equal(partial.PINGROOM_ROOM, undefined); await assert.rejects(loadConnection(s.directory, partial));
  const env = {}; await loadEnvironment(env, path); assert.deepEqual(await loadConnection(s.directory, env), { token: 'file-token', room: ROOM_CODE });
});



const countsFor = (input, values) => Object.fromEntries(tasksFor(input).map((symbol, i) => [symbol.id, values[i]]));
const answersFor = (input, values) => tasksFor(input).map((symbol, i) => ({ symbolId: symbol.id, text: values[i] === null ? null : String(values[i]) }));
const alphabet = (count = 3) => ({ alphabetId: 'fixture', title: 'Practice events', context: 'Observed counts in one practice session.',
  symbols: Array.from({ length: count }, (_, i) => ({ id: String.fromCharCode(97 + i), label: `Event ${i}`, countDefinition: 'Occurrences during the practice session' })) });

// Enumerate all binary partitions of each symbol subset; this does not perform Huffman merging.
function optimalCostOracle(counts) {
  const memo = new Map();
  const cost = mask => {
    if ((mask & (mask - 1)) === 0) return 0;
    if (memo.has(mask)) return memo.get(mask);
    let total = 0, best = Infinity; const first = mask & -mask;
    for (let i = 0; i < counts.length; i++) if (mask & (1 << i)) total += counts[i];
    for (let left = (mask - 1) & mask; left > 0; left = (left - 1) & mask) {
      if (!(left & first)) continue;
      best = Math.min(best, cost(left) + cost(mask ^ left));
    }
    memo.set(mask, total + best); return total + best;
  };
  return cost((1 << counts.length) - 1);
}
function assertPrefixFree(book) {
  for (const a of book.codes) {
    assert.ok(a.bits.length >= 1 && a.bits.length <= book.codes.length - 1);
    assert.match(a.bits, /^[01]+$/); assert.equal(a.length, a.bits.length);
    for (const b of book.codes) if (a.symbolId !== b.symbolId) assert.equal(b.bits.startsWith(a.bits), false);
  }
}

test('strict grammar validates normalized returned text, including zero and Unknown', () => {
  assert.deepEqual(parseCount('0'), { kind: 'quantity', count: 0 }); assert.deepEqual(parseCount('999999'), { kind: 'quantity', count: 999999 });
  assert.deepEqual(parseCount('Unknown'), { kind: 'unknown', count: null });
  for (const text of ['', '-0', '+1', '01', '1.0', '1e2', '1000000', 'unknown', ' Unknown', 'Unknown\n', '1 ', '1\n', '1\r\n', '1\u2028', '1\u2029', '１２', '١', '\ud800', null, 1]) assert.throws(() => parseCount(text));
});

test('known six-symbol example has optimal weighted length 224 bits', () => {
  const input = alphabet(6), result = huffman(input, countsFor(input, [5,9,12,13,16,45]));
  assert.equal(result.weightedBits, '224'); assert.equal(result.totalCount, '100'); assert.equal(result.fixedWidthBits, '300'); assert.equal(result.savedBits, '76');
  assert.deepEqual(result.averageBits, { numerator: '224', denominator: '100' }); assertPrefixFree(result.codebook);
  assert.doesNotThrow(() => JSON.stringify(result)); assert.deepEqual(validateCodebook(result.codebook), result.codebook);
});

test('5456 bounded alphabets match independent optimal binary-tree partition costs', () => {
  let cases = 0;
  for (let size = 2; size <= 6; size++) for (let code = 0; code < 4 ** size; code++) {
    let digits = code; const counts = Array.from({ length: size }, () => { const digit = digits % 4; digits = Math.floor(digits / 4); return digit; });
    const input = alphabet(size), result = huffman(input, countsFor(input, counts)), optimum = optimalCostOracle(counts);
    if (counts.every(count => count === 0)) { assert.equal(result.codable, false); assert.equal(result.codebook, null); }
    else {
      assert.equal(result.weightedBits, String(optimum), `counts=${counts}`); assertPrefixFree(result.codebook);
      const sequence = input.symbols.flatMap(symbol => [symbol.id,symbol.id]); assert.deepEqual(decode(result.codebook, encode(result.codebook, sequence)), sequence);
    }
    cases++;
  }
  assert.equal(cases, 5456);
});

test('equal counts and subtree ties use ASCII minimum-leaf IDs deterministically', () => {
  const input = alphabet(4), equal = huffman(input, countsFor(input, [1,1,1,1])).codebook;
  assert.deepEqual(equal.codes.map(row => row.bits), ['00','01','10','11']);
  const tied = huffman(input, countsFor(input, [1,1,2,4])).codebook;
  assert.deepEqual(tied.codes.map(row => row.bits), ['000','001','01','1']);
  assert.equal(tied.policyHash, POLICY_HASH); assert.equal(tied.policy.queueOrder, POLICY.queueOrder);
});

test('zero-count symbols remain encodable with one positive count', () => {
  const input = alphabet(4), book = huffman(input, countsFor(input, [0,0,0,9])).codebook;
  assert.equal(book.weightedBits, '9'); assert.deepEqual(book.codes.map(row => row.bits), ['000','001','01','1']);
  const sequence = ['a','b','c','d']; assert.deepEqual(decode(book, encode(book, sequence)), sequence); assertPrefixFree(book);
});

test('all known zero counts complete negative analysis and refuse codebook plus codec', async t => {
  const input = alphabet(2), s = await setup(t, input), result = await decide(s, ['0','0']);
  assert.equal(result.status, 'complete'); assert.equal(result.analysis.codable, false); assert.equal(result.analysis.reason, 'zero_count_sum');
  assert.equal(result.analysis.weightedBits, null); assert.equal(result.analysis.averageBits, null); assert.equal(result.analysis.codebook, null); assert.equal(result.proposal, null);
  await assert.rejects(exportProposal(s.directory, input)); await assert.rejects(codec(s.directory, input, 'encode', [])); await assert.rejects(codec(s.directory, input, 'decode', {}));
  const audit = await exportAnalysis(s.directory, input), { observedStatus, ...expected } = result; assert.deepEqual(audit, expected);
  assert.equal((await stat(join(s.directory, 'analysis.json'))).mode & 0o777, 0o600);
});

test('maximum counts retain exact cost and bounds', () => {
  const input = alphabet(8), result = huffman(input, countsFor(input, Array(8).fill(MAX_COUNT)));
  assert.equal(result.totalCount, '7999992'); assert.equal(result.weightedBits, '23999976'); assert.equal(result.savedBits, '0');
  assert.ok(result.codebook.codes.every(row => row.length === 3));
  const skewed = huffman(input, countsFor(input, [0,0,0,0,0,0,0,MAX_COUNT])); assert.equal(skewed.weightedBits, '999999');
  assert.equal(Math.max(...skewed.codebook.codes.map(row => row.length)), 7);
});

test('proportional count scaling preserves codes and input permutation preserves canonical hash', () => {
  const input = alphabet(4), counts = [2,7,3,0], original = huffman(input, countsFor(input, counts)).codebook;
  const scaled = huffman(input, countsFor(input, counts.map(x => x * 177))).codebook;
  assert.deepEqual(original.codes.map(row => row.bits), scaled.codes.map(row => row.bits)); assert.equal(BigInt(scaled.weightedBits), BigInt(original.weightedBits) * 177n);
  assert.notEqual(scaled.codebookHash, original.codebookHash);
  const reversed = structuredClone(input); reversed.symbols.reverse(); assert.deepEqual(huffman(reversed, countsFor(input, counts)).codebook, original);
});

test('unknown, missing and malformed evidence withholds codebook and codec', async t => {
  const input = alphabet(2);
  for (const values of [[null,0],['Unknown',0]]) assert.deepEqual(prefixCodebook(input, answersFor(input, values)), { status:'incomplete', analysis:null });
  for (const values of [['Unknown','5'],['01','5']]) {
    const s = await setup(t, input), result = await decide(s, values); assert.equal(result.status, 'incomplete'); assert.equal(result.analysis, null); assert.equal(result.proposal, null);
    await assert.rejects(exportProposal(s.directory, input)); await assert.rejects(exportAnalysis(s.directory, input)); await assert.rejects(codec(s.directory, input, 'encode', []));
  }
});

test('input, config and exact count map boundaries reject ambiguous values', () => {
  const mutations = [v => v.symbols = [], v => v.symbols.push(v.symbols[0]), v => v.symbols[0].id = 'constructor', v => v.symbols[0].label = '',
    v => v.symbols[0].countDefinition = '', v => v.symbols[0].count = 2, v => v.extra = true, v => v.title += '\n', v => v.context = '\ud800',
    v => v.symbols[0] = { 'id,label':'x', countDefinition:'x' }];
  for (const change of mutations) { const value = alphabet(); change(value); assert.throws(() => validateInput(value)); }
  for (const value of [{a:1}, {a:1,b:2,c:3}, {a:1,b:-0}, {a:1,b:1.5}, {a:1,b:1000000}, {'a,b':1}, {a:NaN,b:2}]) assert.throws(() => huffman(alphabet(2), value));
  assert.throws(() => validateConfig({participant:{...CONFIG.participant,extra:true}}));
  assert.throws(() => prefixCodebook(alphabet(2), [{symbolId:'b',text:'1'},{symbolId:'a',text:'2'}]));
});

test('prompts include full observation meaning and stay within SDK limits', () => {
  const input = alphabet(8); input.alphabetId = 'a'.repeat(40); input.title = '🙂'.repeat(20); input.context = '🙂'.repeat(40);
  input.symbols = input.symbols.map((symbol, i) => ({ ...symbol, id:'a'.repeat(15)+i, label:'🙂'.repeat(15), countDefinition:'🙂'.repeat(40) }));
  for (const symbol of tasksFor(input)) {
    const request = requestFor(input, CONFIG, symbol.id, id(1));
    assert.ok(request.prompt.length <= 500); assert.ok(request.context.length <= 40); assert.ok(Buffer.byteLength(JSON.stringify(request.data)) <= 8192); assert.equal(Object.keys(request.data).length, 5);
    for (const text of [input.context, input.alphabetId, symbol.id, symbol.label, symbol.countDefinition]) assert.ok(request.prompt.includes(text));
    assert.equal(request.data.policy_hash, POLICY_HASH); assert.equal(request.target_user_id, CONFIG.participant.id);
  }
});

test('source and policy bind saved requests before further API calls', async t => {
  const s = await setup(t); await s.run(); const before = s.api.calls.length;
  for (const mutate of [v => v.alphabetId = 'different', v => v.context = 'New window', v => v.symbols[0].countDefinition = 'Other event', v => v.symbols[0].id = 'new']) {
    const input = structuredClone(s.options.input); mutate(input); await assert.rejects(s.run({input}));
  }
  const state = await s.saved(); state.attempts[0].request.data.policy_hash = '0'.repeat(64); await atomicJson(s.directory, 'state.json', state); await assert.rejects(s.run()); assert.equal(s.api.calls.length, before);
});

test('private codebook export retains source, attributed counts and identical bytes', async t => {
  const s = await setup(t), result = await decide(s, ['2','3','5','20']), exported = await exportProposal(s.directory, s.options.input);
  assert.deepEqual(exported, result.proposal); assert.equal(exported.analysis.weightedBits, '45');
  for (const answer of exported.answers) { assert.equal(answer.responderId, CONFIG.participant.id); assert.equal(answer.askerId, ASKER); assert.ok(answer.questionId && answer.attemptId && answer.answeredAt); assert.equal(answer.count, Number(answer.text)); }
  const path = join(s.directory, 'codebook.json'), bytes = await readFile(path, 'utf8'); assert.equal((await stat(path)).mode & 0o777, 0o600);
  await exportProposal(s.directory, s.options.input); assert.equal(await readFile(path, 'utf8'), bytes);
});

test('strict boundaries reject trailing line terminators and malformed Unicode before API access', async t => {
  const s = await setup(t);
  for (const ending of ['\n','\r','\r\n','\u2028','\u2029']) {
    assert.equal(ROOM.test(ROOM_CODE+ending), false); assert.equal(isId(CONFIG.participant.id+ending), false); assert.equal(TOKEN.test('fixture'+ending), false);
    await assert.rejects(s.run({token:'fixture'+ending})); await assert.rejects(s.run({room:ROOM_CODE+ending}));
    const input=structuredClone(example); input.symbols[0].id+=ending; await assert.rejects(s.run({input})); await assert.rejects(atomicText(s.directory,'report.json'+ending,'{}'));
  }
  for (const ending of ['\u0000','\u0085','\u200e','\u2028','\ud800']) {const input=structuredClone(example); input.symbols[0].label+=ending; assert.throws(()=>validateInput(input));}
  assert.equal(s.api.calls.length,0);
});

test('saved parsed counts and monotonic observations cannot be forged', async t => {
  const s=await setup(t);await s.run();s.api.answer(id(1),'5');await s.run();const state=await s.saved();
  for(const mutate of [a=>a.count++,a=>a.text='6',a=>a.kind='unknown']) {const changed=structuredClone(state);mutate(changed.attempts[0].observation.answer);assert.throws(()=>validateState(changed,s.options.input));}
  await s.run();const saved=await s.saved();s.clock.value='2026-01-01T08:59:59.000Z';await assert.rejects(s.run());assert.deepEqual(await s.saved(),saved);
});

test('codec round trips empty and maximum-length sequences including unobserved events', () => {
  const input=alphabet(8),book=huffman(input,countsFor(input,[0,0,0,0,0,0,0,1])).codebook;
  const empty=encode(book,[]);assert.deepEqual(empty,{version:1,codebookHash:book.codebookHash,symbolCount:0,bitLength:0,bits:''});assert.deepEqual(decode(book,empty),[]);
  const longest=book.codes.reduce((a,b)=>a.length>b.length?a:b),sequence=Array(MAX_SYMBOLS).fill(longest.symbolId),packet=encode(book,sequence);
  assert.equal(packet.bitLength,MAX_BITS);assert.deepEqual(decode(book,packet),sequence);
});

test('encoder rejects undeclared symbols, sparse arrays, non-arrays and size overflow', () => {
  const input=alphabet(),book=huffman(input,{a:1,b:2,c:3}).codebook;
  for(const sequence of [['missing'],['a\n'],[1],{},null,Array(MAX_SYMBOLS+1).fill('a'),Array(1)])assert.throws(()=>encode(book,sequence));
});

test('decoder rejects malformed bits, metadata, extra symbols, dangling prefixes and drift', () => {
  const input=alphabet(),book=huffman(input,{a:1,b:2,c:3}).codebook,packet=encode(book,['a','b','c']);
  for(const mutate of [p=>p.bits+='\n',p=>p.bits='2',p=>p.bits='０',p=>p.bitLength++,p=>p.symbolCount++,p=>p.symbolCount--,p=>p.symbolCount=-0,p=>p.symbolCount=MAX_SYMBOLS+1,p=>p.bitLength=MAX_BITS+1,p=>p.extra=true,p=>p.version=2,p=>p.codebookHash='0'.repeat(64)]) {
    const changed=structuredClone(packet);mutate(changed);assert.throws(()=>decode(book,changed));
  }
  const long=book.codes.find(row=>row.length>1),prefix=long.bits.slice(0,-1);
  assert.throws(()=>decode(book,{...packet,symbolCount:1,bitLength:prefix.length,bits:prefix}),/inside/);
  const one=encode(book,['a']);assert.throws(()=>decode(book,{...one,symbolCount:0}),/extra symbols/);
  assert.throws(()=>decode(book,{...one,bits:'',bitLength:0}),/count/);
  assert.throws(()=>decode(huffman(input,{a:2,b:4,c:6}).codebook,packet),/hash/);
  const changedSource=structuredClone(input);changedSource.context='Other session';assert.throws(()=>decode(huffman(changedSource,{a:1,b:2,c:3}).codebook,packet),/hash/);
});

test('codebook validation rejects changed codewords, counts, source, policy and self-rehashed output', () => {
  const book=huffman(alphabet(3),{a:1,b:2,c:3}).codebook;
  for(const mutate of [b=>b.codes[0].bits='1',b=>b.codes[0].count++,b=>b.codes[0].length++,b=>b.codes.reverse(),b=>b.source.context='Other session',b=>b.policy={...b.policy,branches:'different'},b=>b.weightedBits='0',b=>b.extra=true]) {
    const changed=structuredClone(book);mutate(changed);const {codebookHash,...body}=changed;changed.codebookHash=hash(body);
    assert.throws(()=>validateCodebook(changed));assert.throws(()=>encode(changed,[]));
  }
});

test('valid altered payloads can decode: codebook hash is not packet authentication', () => {
  const book=huffman(alphabet(4),{a:1,b:1,c:1,d:1}).codebook,packet=encode(book,['a']);
  assert.deepEqual(decode(book,{...packet,bits:'01'}),['b']);
});

test('offline codec writes private output, refuses incomplete state and preserves prior files on failure', async t => {
  const s=await setup(t);await assert.rejects(codec(s.directory,s.options.input,'encode',[]));await s.run();await assert.rejects(codec(s.directory,s.options.input,'encode',[]));
  s.api.answer(id(1),'2');await s.run();await decide(s,['3','5','20']);const before=s.api.calls.length;
  const sequence=['open','view','save','close'],packet=await codec(s.directory,s.options.input,'encode',sequence);
  assert.deepEqual(await codec(s.directory,s.options.input,'decode',packet),sequence);assert.equal(s.api.calls.length,before);
  const path=join(s.directory,'packet.json'),bytes=await readFile(path,'utf8');assert.equal((await stat(path)).mode&0o777,0o600);
  await assert.rejects(codec(s.directory,s.options.input,'encode',['absent']));assert.equal(await readFile(path,'utf8'),bytes);
  const decoded=await readFile(join(s.directory,'decoded.json'),'utf8');await assert.rejects(codec(s.directory,s.options.input,'decode',{...packet,symbolCount:0}));assert.equal(await readFile(join(s.directory,'decoded.json'),'utf8'),decoded);
});
