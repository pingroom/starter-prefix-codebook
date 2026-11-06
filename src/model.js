import { createHash } from 'node:crypto';

export const TTL = 900;
export const CLOCK_SKEW_MS = 60000;
export const TOKEN = /^[^\s\x00-\x1f\x7f]{1,8192}(?![\s\S])/;
export const ROOM = /^[A-Z0-9]{12}$(?![\s\S])/;
export const isId = (value) => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$(?![\s\S])/.test(value);
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value, expected) => {
  if (!record(value)) return false;
  const actual = Object.keys(value).sort(), wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
};
const word = (value) => typeof value === 'string' && /^[a-z][a-z0-9_-]{0,39}$(?![\s\S])/.test(value);
const line = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max && value.isWellFormed()
  && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value) && value.trim() === value;
const canonical = (value) => Array.isArray(value) ? value.map(canonical) : record(value) ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
export const hash = (value) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');

export function iso(raw) {
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|\+00:00)$(?![\s\S])/.test(raw)) throw new Error('Expected a UTC timestamp.');
  const time = Date.parse(raw);
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 19) !== raw.slice(0, 19)) throw new Error('Invalid UTC timestamp.');
  return new Date(time).toISOString();
}


export const MAX_COUNT = 999999;
export const MAX_SYMBOLS = 4096;
export const MAX_BITS = MAX_SYMBOLS * 7;
export const POLICY = Object.freeze({ algorithm: 'huffman-all-declared-symbols-v1', queueOrder: 'count-then-smallest-ascii-leaf-id-v1', branches: 'first-0-second-1-v1', zeroCounts: 'retain-symbols-refuse-zero-total-v1' });
export const POLICY_HASH = hash(POLICY);
const safeId = value => word(value) && value.length <= 16 && !['constructor', 'prototype', '__proto__'].includes(value);
const integer = (value, max) => Number.isSafeInteger(value) && value >= 0 && value <= max && !Object.is(value, -0);
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const symbolPrompt = (input, symbol) => `${input.title}\nContext: ${input.context}\nAlphabet: ${input.alphabetId}\nSymbol ${symbol.id}: ${symbol.label}\nCount means: ${symbol.countDefinition}\nReport observed count: 0 to 999999 (digits only, no leading zeros), or Unknown. Do not estimate missing counts.`;

export function validateInput(input) {
  if (!keys(input, ['alphabetId', 'title', 'context', 'symbols']) || !word(input.alphabetId)
    || !line(input.title, 40) || !line(input.context, 80) || !Array.isArray(input.symbols) || input.symbols.length < 2 || input.symbols.length > 8) throw new Error('Provide an alphabet ID, title, context and two to eight event symbols.');
  const ids = new Set();
  for (const symbol of input.symbols) {
    if (!keys(symbol, ['id', 'label', 'countDefinition']) || !safeId(symbol.id) || ids.has(symbol.id) || !line(symbol.label, 30)
      || !line(symbol.countDefinition, 80) || symbolPrompt(input, symbol).length > 500) throw new Error('Symbols require unique safe IDs, labels up to 30, count definitions up to 80, and a full prompt within 500 characters.');
    ids.add(symbol.id);
  }
  return { ...structuredClone(input), symbols: structuredClone(input.symbols).sort((a, b) => compare(a.id, b.id)) };
}
export function validateConfig(config) {
  if (!keys(config, ['participant']) || !keys(config.participant, ['id', 'label']) || !isId(config.participant.id) || !line(config.participant.label, 60)) throw new Error('Config requires an exact count operator UUID and label.');
  return structuredClone(config);
}
export const tasksFor = input => validateInput(input).symbols;
export function parseCount(text) {
  if (text === 'Unknown') return { kind: 'unknown', count: null };
  if (typeof text !== 'string' || !/^(?:0|[1-9][0-9]{0,5})(?![\s\S])/.test(text)) throw new Error('Reply with an integer from 0 to 999999 without spaces or leading zeros, or exactly Unknown.');
  return { kind: 'quantity', count: Number(text) };
}
export function requestFor(rawInput, config, taskId, attemptId) {
  const input = validateInput(rawInput), symbol = input.symbols.find(row => row.id === taskId); validateConfig(config);
  if (!symbol || !isId(attemptId)) throw new Error('Invalid symbol or attempt.');
  const key = `codebook-${attemptId}`;
  return { prompt: symbolPrompt(input, symbol), context: `To ${config.participant.id}`, text_input: { placeholder: '0 to 999999 or Unknown', max_length: 60 },
    responder_scope: 'direct', target_user_id: config.participant.id, ttl: TTL, correlation_id: key,
    data: { input_hash: hash(input), symbol_hash: hash(symbol), policy_hash: POLICY_HASH, task_id: taskId, attempt_id: attemptId }, idempotencyKey: key };
}

/** Keep zero-count leaves so every declared event remains encodable. */
export function huffman(rawInput, counts) {
  const input = validateInput(rawInput);
  if (!keys(counts, input.symbols.map(symbol => symbol.id)) || Object.values(counts).some(value => !integer(value, MAX_COUNT))) throw new Error('Every declared symbol requires one bounded integer count.');
  const total = input.symbols.reduce((sum, symbol) => sum + BigInt(counts[symbol.id]), 0n);
  const fixedWidth = Math.ceil(Math.log2(input.symbols.length));
  if (total === 0n) return { codable: false, reason: 'zero_count_sum', totalCount: '0', weightedBits: null, fixedWidthBitsPerSymbol: fixedWidth, fixedWidthBits: '0', savedBits: null, averageBits: null, codebook: null };
  const queue = input.symbols.map(symbol => ({ count: BigInt(counts[symbol.id]), minId: symbol.id, symbolId: symbol.id }));
  while (queue.length > 1) {
    queue.sort((a, b) => compare(a.count, b.count) || compare(a.minId, b.minId));
    const left = queue.shift(), right = queue.shift();
    queue.push({ count: left.count + right.count, minId: compare(left.minId, right.minId) <= 0 ? left.minId : right.minId, left, right });
  }
  const paths = new Map();
  const visit = (node, prefix) => {
    if (node.symbolId !== undefined) paths.set(node.symbolId, prefix);
    else { visit(node.left, prefix + '0'); visit(node.right, prefix + '1'); }
  };
  visit(queue[0], '');
  const codes = input.symbols.map(symbol => ({ symbolId: symbol.id, count: counts[symbol.id], bits: paths.get(symbol.id), length: paths.get(symbol.id).length }));
  const cost = codes.reduce((sum, row) => sum + BigInt(row.count) * BigInt(row.length), 0n), baseline = total * BigInt(fixedWidth);
  const book = { version: 1, source: input, sourceHash: hash(input), policy: POLICY, policyHash: POLICY_HASH, codes,
    totalCount: total.toString(), weightedBits: cost.toString(), fixedWidthBitsPerSymbol: fixedWidth, fixedWidthBits: baseline.toString(), savedBits: (baseline - cost).toString() };
  const codebook = { ...book, codebookHash: hash(book) };
  return { codable: true, reason: null, totalCount: total.toString(), weightedBits: cost.toString(), fixedWidthBitsPerSymbol: fixedWidth,
    fixedWidthBits: baseline.toString(), savedBits: (baseline - cost).toString(), averageBits: { numerator: cost.toString(), denominator: total.toString() }, codebook };
}
export function prefixCodebook(rawInput, answers) {
  const input = validateInput(rawInput), tasks = tasksFor(input);
  if (!Array.isArray(answers) || answers.length !== tasks.length || answers.some((row, index) => !keys(row, ['symbolId', 'text']) || row.symbolId !== tasks[index].id || row.text !== null && typeof row.text !== 'string')) throw new Error('Provide one ordered answer or missing outcome for every symbol.');
  const outcomes = answers.map(row => row.text === null ? { kind: 'missing', count: null } : parseCount(row.text));
  if (outcomes.some(row => row.kind !== 'quantity')) return { status: 'incomplete', analysis: null };
  return { status: 'complete', analysis: huffman(input, Object.fromEntries(tasks.map((symbol, index) => [symbol.id, outcomes[index].count]))) };
}

/** Rebuild the canonical book instead of accepting arbitrary lengths or hashes. */
export function validateCodebook(book) {
  if (!keys(book, ['version', 'source', 'sourceHash', 'policy', 'policyHash', 'codes', 'totalCount', 'weightedBits', 'fixedWidthBitsPerSymbol', 'fixedWidthBits', 'savedBits', 'codebookHash'])) throw new Error('Invalid codebook shape.');
  const input = validateInput(book.source);
  if (!Array.isArray(book.codes) || book.codes.length !== input.symbols.length || book.codes.some((row, index) => !keys(row, ['symbolId', 'count', 'bits', 'length']) || row.symbolId !== input.symbols[index].id || !integer(row.count, MAX_COUNT))) throw new Error('Invalid ordered codebook counts.');
  const expected = huffman(input, Object.fromEntries(book.codes.map(row => [row.symbolId, row.count]))).codebook;
  if (expected === null || hash(book) !== hash(expected)) throw new Error('Codebook differs from its declared counts, source or current policy.');
  return expected;
}
export function encode(book, symbols) {
  book = validateCodebook(book);
  if (!Array.isArray(symbols) || symbols.length > MAX_SYMBOLS) throw new Error(`Encode an array of at most ${MAX_SYMBOLS} symbol IDs.`);
  const byId = new Map(book.codes.map(row => [row.symbolId, row.bits])), chunks = [];
  for (const symbol of symbols) { if (typeof symbol !== 'string' || !byId.has(symbol)) throw new Error('Sequence contains an undeclared symbol.'); chunks.push(byId.get(symbol)); }
  const bits = chunks.join('');
  return { version: 1, codebookHash: book.codebookHash, symbolCount: symbols.length, bitLength: bits.length, bits };
}
export function decode(book, packet) {
  book = validateCodebook(book);
  if (!keys(packet, ['version', 'codebookHash', 'symbolCount', 'bitLength', 'bits']) || packet.version !== 1 || packet.codebookHash !== book.codebookHash
    || !integer(packet.symbolCount, MAX_SYMBOLS) || !integer(packet.bitLength, MAX_BITS) || typeof packet.bits !== 'string' || packet.bits.length !== packet.bitLength
    || !/^[01]*(?![\s\S])/.test(packet.bits)) throw new Error('Invalid packet fields, limits, bits or codebook hash.');
  const byBits = new Map(book.codes.map(row => [row.bits, row.symbolId]));
  const prefixes = new Set(book.codes.flatMap(row => Array.from({ length: row.bits.length }, (_, i) => row.bits.slice(0, i + 1))));
  const symbols = []; let prefix = '';
  for (const bit of packet.bits) {
    prefix += bit;
    if (byBits.has(prefix)) { symbols.push(byBits.get(prefix)); prefix = ''; if (symbols.length > packet.symbolCount) throw new Error('Packet contains extra symbols beyond its declared count.'); }
    else if (!prefixes.has(prefix)) throw new Error('Packet contains an unknown code prefix.');
  }
  if (prefix !== '') throw new Error('Packet ends inside a codeword.');
  if (symbols.length !== packet.symbolCount) throw new Error('Packet symbol count does not match decoded symbols.');
  return symbols;
}

export function validateState(state, rawInput) {
  const input = validateInput(rawInput), tasks = tasksFor(input);
  if (!keys(state, ['version', 'inputHash', 'config', 'room', 'credentialHash', 'startedAt', 'attempts']) || state.version !== 1
    || state.inputHash !== hash(input) || typeof state.room !== 'string' || !ROOM.test(state.room)
    || typeof state.credentialHash !== 'string' || state.credentialHash.length !== 64 || !/^[0-9a-f]{64}$/.test(state.credentialHash)
    || !Array.isArray(state.attempts) || state.attempts.length > tasks.length || iso(state.startedAt) !== state.startedAt) {
    throw new Error('Invalid state or changed event alphabet. Restore the original inputs.');
  }
  validateConfig(state.config);
  const ids = new Set(), questionIds = new Set();
  let previous = state.startedAt, askerId;
  for (const [index, attempt] of state.attempts.entries()) {
    if (!keys(attempt, ['id', 'taskId', 'createdAt', 'request', 'questionId', 'status', 'observation'])
      || !isId(attempt.id) || ids.has(attempt.id) || attempt.taskId !== tasks[index].id
      || iso(attempt.createdAt) !== attempt.createdAt || attempt.createdAt < previous
      || hash(attempt.request) !== hash(requestFor(input, state.config, attempt.taskId, attempt.id))
      || !['creating', 'pending', 'answered', 'expired', 'cancelled', 'invalid_answer'].includes(attempt.status)) {
      throw new Error('Invalid saved count request.');
    }
    ids.add(attempt.id);
    previous = attempt.createdAt;
    if (attempt.status === 'creating') {
      if (attempt.questionId !== null || attempt.observation !== null) throw new Error('Invalid uncertain creation state.');
    } else {
      if (!isId(attempt.questionId) || questionIds.has(attempt.questionId)) throw new Error('Invalid or repeated Question ID.');
      questionIds.add(attempt.questionId);
      validateObservation(attempt.observation, attempt.status, attempt.request);
      if (Date.parse(attempt.observation.createdAt) < Date.parse(attempt.createdAt) - CLOCK_SKEW_MS
        || attempt.observation.checkedAt < attempt.createdAt) throw new Error('Observation predates creation intent.');
      previous = attempt.observation.checkedAt;
      if (askerId !== undefined && attempt.observation.askerId !== askerId) throw new Error('Questions belong to different asking registrations.');
      askerId = attempt.observation.askerId;
    }
    if (['creating', 'pending'].includes(attempt.status) && index !== state.attempts.length - 1) {
      throw new Error('Only the last task may have an active Question.');
    }
  }
  return state;
}

export function report(state, rawInput) {
  const input = validateInput(rawInput); validateState(state, input);
  const answers = tasksFor(input).map(symbol => {
    const attempt = state.attempts.find(row => row.taskId === symbol.id), answer = attempt?.observation?.answer;
    return { symbolId: symbol.id, symbolHash: hash(symbol), status: attempt?.status === 'creating' ? 'create_unknown' : attempt?.status ?? 'unasked',
      text: answer?.text ?? null, kind: answer?.kind ?? null, count: answer?.count ?? null,
      questionId: attempt?.questionId ?? null, attemptId: attempt?.id ?? null,
      responderId: answer?.responderId ?? null, answeredAt: answer?.answeredAt ?? null,
      askerId: attempt?.observation?.askerId ?? null, observedAt: attempt?.observation?.checkedAt ?? null };
  });
  const calculation = prefixCodebook(input, answers.map(({ symbolId, text }) => ({ symbolId, text })));
  const active = answers.find(row => ['create_unknown', 'pending'].includes(row.status));
  const status = active?.status ?? (answers.some(row => row.status === 'unasked') ? 'ready' : calculation.status);
  const evidence = { alphabetId: input.alphabetId, source: input, sourceHash: hash(input), configHash: hash(state.config), policy: POLICY, policyHash: POLICY_HASH,
    participant: state.config.participant, room: state.room, answers, analysis: calculation.analysis };
  return { ...evidence, status, proposal: calculation.status === 'complete' && calculation.analysis.codable ? { ...evidence, status: 'complete' } : null };
}

function validateObservation(observation, status, request) {
  if (!keys(observation, ['createdAt', 'expiresAt', 'checkedAt', 'askerId', 'resolvedAt', 'answer']) || !isId(observation.askerId)) throw new Error('Invalid saved observation.');
  for (const key of ['createdAt', 'expiresAt', 'checkedAt']) if (iso(observation[key]) !== observation[key]) throw new Error('Invalid saved timestamp.');
  const duration = Date.parse(observation.expiresAt) - Date.parse(observation.createdAt);
  if (duration < TTL * 1000 - 1000 || duration > TTL * 1000 + 1000) throw new Error('Question lifetime differs from the saved request.');
  const latest = Date.parse(observation.checkedAt) + CLOCK_SKEW_MS;
  if (Date.parse(observation.createdAt) > latest) throw new Error('Question creation is implausibly in the future. Check the local clock.');
  if (status === 'pending') {
    if (observation.resolvedAt !== null) throw new Error('Pending Question has a resolution timestamp.');
  } else if (iso(observation.resolvedAt) !== observation.resolvedAt || observation.resolvedAt < observation.createdAt
    || Date.parse(observation.resolvedAt) > latest
    || (status === 'expired' ? observation.resolvedAt < observation.expiresAt : observation.resolvedAt > observation.expiresAt)) throw new Error('Invalid Question resolution time.');
  if (status === 'answered') {
    const answer = observation.answer;
    if (!keys(answer, ['text', 'kind', 'count', 'responderId', 'answeredAt']) || answer.responderId !== request.target_user_id
      || hash(parseCount(answer.text)) !== hash({ kind: answer.kind, count: answer.count })
      || iso(answer.answeredAt) !== answer.answeredAt || answer.answeredAt !== observation.resolvedAt
      || answer.answeredAt < observation.createdAt || answer.answeredAt > observation.expiresAt) throw new Error('Invalid saved count evidence.');
  } else if (observation.answer !== null) throw new Error('Unanswered tasks must not contain count evidence.');
}

export function observeQuestion(q, request, questionId, room, checkedAt) {
  if (!isId(questionId) || q?.id !== questionId || q.kind !== 'question' || q.is_handoff !== false
    || q.asker?.type !== 'agent' || !isId(q.asker?.id) || q.prompt !== request.prompt || q.context !== request.context
    || q.responder_scope !== 'direct' || q.target_user_id !== request.target_user_id || q.resolution_policy !== 'first'
    || q.results !== null || hash(q.text_input) !== hash(request.text_input) || q.correlation_id !== request.correlation_id || q.reply_to !== null || hash(q.data) !== hash(request.data)
    || (q.room_code ?? q.room?.code) !== room || q.room_code !== undefined && q.room_code !== room
    || q.room !== undefined && q.room?.code !== room || !['pending', 'answered', 'expired', 'cancelled'].includes(q.state)
    || !Array.isArray(q.options) || q.options.length !== 0) throw new Error('Question does not match the saved task, room, or count operator.');
  const observation = { createdAt: iso(q.created_at), expiresAt: iso(q.expires_at), checkedAt: iso(checkedAt), askerId: q.asker.id,
    resolvedAt: q.resolved_at === null ? null : iso(q.resolved_at), answer: null };
  let status = q.state === 'answered' ? 'invalid_answer' : q.state;
  if (q.state !== 'answered' && q.answer !== null) throw new Error('Unresolved Question includes an unexpected answer.');
  if (q.state === 'answered') {
    const answer = q.answer;
    try {
      if (!answer || answer.value !== null || answer.label !== null || answer.responder?.id !== request.target_user_id || typeof answer.text !== 'string' || answer.text.length > 60) throw new Error('Invalid text answer.');
      observation.answer = { text: answer.text, ...parseCount(answer.text), responderId: answer.responder.id, answeredAt: iso(answer.answered_at) };
      validateObservation(observation, 'answered', request); status = 'answered';
    } catch { observation.answer = null; }
  }
  validateObservation(observation, status, request);
  return { status, observation };
}

export function assertParticipantRoom(rooms, room, participantId) {
  if (!Array.isArray(rooms) || rooms.length > 1000) throw new Error('Invalid room inventory.');
  const matches = rooms.filter((item) => item?.invite_code === room), selected = matches[0];
  if (matches.length !== 1 || selected.type !== 'standard' || selected.is_public !== false || !Array.isArray(selected.members)
    || selected.members.length > 1000 || !selected.members.some((member) => member?.user_id === participantId)) throw new Error('Use a granted standard private room containing the named participant.');
}
