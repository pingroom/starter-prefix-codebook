# PingRoom prefix codebook starter

Collect observed event counts from a named operator through PingRoom, then build a deterministic Huffman codebook. Encode and decode local event sequences with that codebook.

After a logging experiment, define the event alphabet and observation window, collect counts, then evaluate variable-length codes for future traffic. The example uses practice workstation events. It changes no logging systems and sends no data externally.

## Try it offline

Choose **Use this template**, clone your repository, and use Node.js 22 or newer:

```sh
npm ci
npm test
npm run demo
```

Five demos cover ordinary counts, ties, zero-count events, all-zero observations and Unknown. Tests and demos use pinned `@pingroom/sdk` 0.7.1 with local mock transports, require no credentials and do not test live phone delivery. Dependencies are locked; `.npmrc` requests a 14-day minimum release age where npm supports it. GitHub Actions checks Node 22 and 24.

## Define the alphabet

```sh
cp examples/alphabet.json alphabet.json
cp config.example.json config.json
npm run validate
```

Edit `alphabet.json` before collecting counts. It contains `alphabetId`, `title`, `context` and two to eight `symbols`, each with an `id`, `label` and `countDefinition`. State the observation window in `context` and define events consistently for the same stream. Code cannot verify reported counts.

Symbol IDs use 1–16 lowercase ASCII characters, starting with a letter, followed by letters, digits, `_` or `-`; prototype-related names are excluded. The alphabet ID allows 40 characters. Trimmed single-line Unicode text limits are title 40, context 80, label 30 and count definition 80 UTF-16 units. Malformed Unicode, controls and formatting characters are rejected. Symbols are sorted by ID; equivalent reorderings preserve the session.

## Connect and collect

Install [PingRoom](https://pingroom.io/i), then:

```sh
npm run connect
npm run inspect
```

Open the pairing link, approve the connection and grant a standard private room containing the operator. Verify the person in the app and copy their exact member UUID from `inspect` into `config.json` before starting. Names alone do not establish identity. The connection needs room/Question access; keep the original asking registration.

Credentials stay under `.pingroom/`. For an existing connection, copy `.env.example` to `.env` and set both `PINGROOM_TOKEN` and `PINGROOM_ROOM`. A complete environment pair overrides saved credentials; blank or partial pairs cannot borrow missing values from `.env` or saved credentials.

```sh
npm start
# Answer in PingRoom, then record the answer:
npm start
```

Each `npm start` creates at most one Question or reads the active one once. After recording an answer, run it again for the next symbol. Prompts include the alphabet, observation context, symbol ID, label and count definition. At most eight Questions target the operator, each lasting 900 seconds. There is no background polling.

Reply `0`–`999999` without leading zeros, or exactly `Unknown`. Validation checks PingRoom's normalized text; it cannot detect whitespace trimmed by the server. Unknown, missing, invalid, expired or cancelled answers withhold the codebook. Later symbols can still be collected, but terminal Questions are not automatically reissued.

## Export and use the codec

These commands work offline:

```sh
npm run status
npm run report
npm run export
npm run export-analysis
cp examples/symbols.json symbols.json
npm run encode
cp .codebook/packet.json packet.json
npm run decode
```

| Command | Local output |
| --- | --- |
| `report` | `.codebook/report.json`, including partial evidence |
| `export` | `.codebook/codebook.json`, complete evidence with `analysis.codebook` |
| `export-analysis` | `.codebook/analysis.json`, including complete all-zero results |
| `encode` | Reads root `symbols.json`; writes `.codebook/packet.json` |
| `decode` | Reads root `packet.json`; writes `.codebook/decoded.json` |

`symbols.json` is an array of at most 4096 declared symbol IDs. A packet contains exactly `version`, `codebookHash`, `symbolCount`, `bitLength` and a `bits` string of at most 28672 binary digits. Empty sequences use zero count/length and an empty bitstring. Packets store bits as JSON characters for inspection, not packed bytes; exported files may be larger than their source.

Both codec commands reconstruct the codebook from the complete saved session. They reject unknown symbols, malformed packets, dangling prefixes, count/length mismatches and a different codebook hash. Outputs are private and atomic; failures preserve previous files. Require command success and the expected hash before consuming an artifact.

All known zero counts produce complete analysis with `codable: false` and `reason: "zero_count_sum"`. Codebook export and both codec commands refuse that result, including empty sequences. With a positive total, zero-count symbols retain codes and remain encodable.

## Understand the result

The [Huffman algorithm](https://algs4.cs.princeton.edu/55compression/index.php) minimizes count-weighted code length among binary prefix codes over the declared alphabet. Code repeatedly merges the two lowest-count trees. Ties use the smallest ASCII symbol ID in each subtree; the first child gets `0`, the second `1`. All symbols remain in the tree.

Each code row records its symbol, count, bits and length. BigInt calculations export decimal-string totals, weighted bits and savings against `ceil(log2(alphabet size))` bits per symbol. Average length is an exact numerator/denominator pair. These are bit-cost savings for observed counts, not file-size savings: they exclude the codebook, JSON packet and other overhead. Future traffic may differ.

The codebook hash identifies the source, counts, policy and codes. It is not a payload checksum or authentication mechanism: altered bits can decode to a different valid message. This is compression, with no encryption or error correction.

## Recover and adapt

Preserve `alphabet.json`, config, connection and `.codebook/`. Changed inputs, policy or identities cannot reuse answers. Creation intent is saved before POST. For uncertain creation:

```sh
npm run find-id
npm run recover -- EXACT_QUESTION_UUID
```

An empty recent-list search does not prove creation failed. Recovery reads the original Question without another POST. Resolve or revoke uncertain/expired pairing in Connected Agents before archiving its pairing record.

Use persistent storage on one machine. Restore corrupt state from backup; remove a stale lock only after its process stops. Inputs/config/state are ignored by Git. Limits are 64 KiB for the alphabet, 16 KiB for config, 128 KiB for codec inputs, 1 MiB for state/output and 512 KiB for HTTP responses. Saved evidence is historical, not tamper-proof.

Collection exits `0` when complete, `1` on error, `2` for incomplete/newly failed outcomes, `3` while ready/pending/interrupted and `4` for uncertain creation. All-zero analysis also exits `0`; inspect `analysis.codable`. Successful offline commands exit `0`; refused exports/codecs exit `1`.

Adapt the alphabet or use `encode`/`decode` from `src/model.js` with a validated codebook. Keep calculation and execution in code; version `POLICY` when semantics change. The [SDK contract](https://github.com/pingroom/sdk) was checked on 2026-11-06: prompts ≤500, context ≤40, text limit 60 and five metadata keys within the 25-key/8192-byte limits. Tests include 5,456 independent optimal-cost comparisons, codec boundaries, interrupted writes, pairing and CLI subprocesses. [MIT license](LICENSE).
