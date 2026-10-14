/** Curated lowercase aliases and conservative Japanese quotation; synthetic data, mocked provider only. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { inferFactSubject } from '../src/core/facts/subject-infer.ts';
import { judgeBatch } from '../src/core/facts/relink-model.ts';
import { __setChatTransportForTests, configureGateway, resetGateway } from '../src/core/ai/gateway.ts';

let engine: PGLiteEngine;
const page = (slug: string, aliases: string[], extra = '') => importFromContent(engine, slug,
  `---\ntitle: ${slug.split('/').at(-1)}\ntype: project\naliases: ${JSON.stringify(aliases)}\n${extra}---\n\n# Synthetic entity\n`, { noEmbed: true });
const infer = (fact: string, extra = {}) => inferFactSubject(engine, 'default', { fact, mode: 'write', ...extra });

beforeAll(async () => {
  engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema();
  await page('projects/atlas-example', ['atlascode', 'atlas code', 'Atlas', '田中', 'sharedcode', 'documentcollision', 'accountcollision', 'privatecollision', 'deletedcollision', 'today', 'meeting', 'api', 'user', 'launched', 'Apple', 'Target', 'user updates']);
  await page('projects/vertex-example', ['vertexcode', 'sharedcode']);
  await page('records/account-example', ['accountcollision']);
  await engine.executeRaw("UPDATE pages SET type='account' WHERE source_id='default' AND slug='records/account-example'");
  await importFromContent(engine, 'meetings/subject-example', '---\ntitle: Synthetic meeting\ntype: meeting\naliases: [documentcollision, meetingonly]\n---\n\n# Synthetic meeting\n', { noEmbed: true });
  await page('projects/hidden-example', ['hiddencode', 'privatecollision'], 'visibility: private\n');
  await page('projects/deleted-example', ['deletedcode', 'deletedcollision']);
  await engine.executeRaw("UPDATE pages SET deleted_at=now() WHERE source_id='default' AND slug='projects/deleted-example'");
  await engine.executeRaw("INSERT INTO sources (id,name) VALUES ('names-other','names-other') ON CONFLICT DO NOTHING");
}, 120_000);
afterAll(async () => { await engine.disconnect(); });
beforeEach(() => { configureGateway({ chat_model: 'anthropic:claude-haiku-4-5', env: { ANTHROPIC_API_KEY: 'sk-test' } } as never); });
afterEach(() => { __setChatTransportForTests(null); resetGateway(); });

describe('curated weak Latin aliases', () => {
  test('unique aliases link in both write and relink modes', async () => {
    for (const mode of ['write', 'relink'] as const) for (const name of ['atlascode', 'atlas code']) {
      expect(await infer(`${name} ships weekly`, { mode })).toEqual({ slug: 'projects/atlas-example', via: 'mention' });
    }
  });
  test('unregistered words, basename guesses and CJK grams remain unsupported', async () => {
    for (const fact of ['vertex example ships weekly', 'atlas-example ships weekly', 'unknowncode ships weekly', '田中は更新した']) {
      expect((await infer(fact)).slug).toBeNull();
    }
  });
  test('registered common, role, generic, opener and ambiguous brand aliases are ignored', async () => {
    for (const word of ['today', 'meeting', 'api', 'user', 'launched', 'apple', 'target', 'user updates']) {
      expect((await infer(`${word} ships weekly`)).slug).toBeNull();
    }
  });
  test('registered competitors, collisions and unknown capitalized competitors veto', async () => {
    for (const fact of ['atlascode copied vertexcode', 'sharedcode ships weekly', 'atlascode copied Northstar Example']) {
      expect(await infer(fact)).toMatchObject({ slug: null, reason: 'ambiguous' });
    }
  });
  test('longer names and first-name guesses never match a shorter alias', async () => {
    for (const fact of ['atlascodeplus ships weekly', 'xatlascode ships weekly', 'atlascode中文 ships weekly', 'atlascodé ships weekly', '́atlascode ships weekly', 'atlas-example ships weekly']) {
      expect((await infer(fact)).slug).toBeNull();
    }
  });
  test('source, deletion and private filtering apply before uniqueness', async () => {
    expect((await inferFactSubject(engine, 'names-other', { fact: 'atlascode ships weekly', mode: 'write' })).slug).toBeNull();
    expect((await infer('deletedcode ships weekly')).slug).toBeNull();
    expect(await infer('deletedcollision ships weekly')).toMatchObject({ slug: 'projects/atlas-example' });
    expect(await infer('hiddencode ships weekly')).toMatchObject({ slug: 'projects/hidden-example' });
    expect((await infer('hiddencode ships weekly', { excludePrivate: true })).slug).toBeNull();
    expect(await infer('privatecollision ships weekly')).toMatchObject({ slug: null, reason: 'ambiguous' });
    expect(await infer('privatecollision ships weekly', { excludePrivate: true })).toMatchObject({ slug: 'projects/atlas-example' });
  });
  test('a document alias does not hide the sole entity or veto trusted page provenance', async () => {
    expect(await infer('documentcollision ships weekly')).toMatchObject({ slug: 'projects/atlas-example' });
    expect(await infer('documentcollision ships weekly', { pageSlug: 'projects/atlas-example' }))
      .toEqual({ slug: 'projects/atlas-example', via: 'page' });
    expect(await infer('meetingonly ships weekly', { pageSlug: 'projects/atlas-example' }))
      .toEqual({ slug: 'projects/atlas-example', via: 'page' });
    expect((await infer('meetingonly ships weekly')).slug).toBeNull();
  });
  test('private alias origins cannot hide a readable alias before origin precedence', async () => {
    await page('projects/readable-origin-example', ['originprivacycode']);
    await page('projects/private-origin-example', ['originprivacycode'], 'visibility: private\n');
    await engine.executeRaw("UPDATE page_aliases SET origin='declared' WHERE source_id='default' AND slug='projects/readable-origin-example' AND alias_norm='originprivacycode'");
    const remote = await infer('originprivacycode ships weekly', { excludePrivate: true });
    expect(remote).toMatchObject({ slug: 'projects/readable-origin-example' });
    expect(await infer('originprivacycode ships weekly')).toMatchObject({ slug: 'projects/private-origin-example' });
    await engine.executeRaw("UPDATE pages SET deleted_at=now() WHERE source_id='default' AND slug='projects/private-origin-example'");
    expect(await infer('originprivacycode ships weekly', { excludePrivate: true })).toEqual(remote);
  });
  test('custom entity types compete with builtin entities through their shared alias', async () => {
    const original = await engine.getConfig('mentions.entity_types');
    try {
      await engine.setConfig('mentions.entity_types', 'account');
      expect(await infer('accountcollision ships weekly')).toMatchObject({ slug: null, reason: 'ambiguous' });
    } finally { await engine.setConfig('mentions.entity_types', original ?? ''); }
  });
  test('policy and schema-pack failures cannot turn a custom-type collision into a unique alias', async () => {
    const original = await engine.getConfig('mentions.entity_types');
    try {
      await engine.setConfig('mentions.entity_types', 'account');
      const policyFault = new Proxy(engine, { get(target, key) {
        if (key === 'executeRaw') return async (sql: string, params?: unknown[]) => {
          if (sql.includes('SELECT key, value FROM config')) throw new Error('policy config unavailable');
          return target.executeRaw(sql, params);
        };
        if (key === 'getConfig') return async (name: string) => {
          if (name.startsWith('mentions.') || name === 'auto_link') throw new Error('policy config unavailable');
          return target.getConfig(name);
        };
        const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
      } });
      await expect(inferFactSubject(policyFault, 'default', { fact: 'accountcollision ships weekly', mode: 'write' }))
        .rejects.toThrow('policy config unavailable');
      const packFault = new Proxy(engine, { get(target, key) {
        if (key === 'getConfig') return async (name: string) => {
          if (name === 'schema_pack') throw new Error('schema pack unavailable');
          return target.getConfig(name);
        };
        const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
      } });
      await expect(inferFactSubject(packFault, 'default', { fact: 'accountcollision ships weekly', mode: 'write' }))
        .rejects.toThrow('schema pack unavailable');
    } finally { await engine.setConfig('mentions.entity_types', original ?? ''); }
  });
  test('missing alias tables abstain while other lookup failures propagate', async () => {
    const aliases = spyOn(engine, 'resolveAliases');
    try {
      aliases.mockRejectedValueOnce(Object.assign(new Error('relation page_aliases does not exist'), { code: '42P01' }));
      expect((await infer('atlascode ships weekly')).slug).toBeNull();
      aliases.mockRejectedValueOnce(new Error('alias database offline'));
      await expect(infer('atlascode ships weekly')).rejects.toThrow('alias database offline');
    } finally { aliases.mockRestore(); }
  });
  test('weak admission batches aliases without basename, prefix or fuzzy resolver queries', async () => {
    const aliases = spyOn(engine, 'resolveAliases'); const raw = spyOn(engine, 'executeRaw');
    try {
      expect(await infer('atlascode ships weekly', { mode: 'relink' })).toMatchObject({ slug: 'projects/atlas-example' });
      expect(aliases).toHaveBeenCalledTimes(1);
      expect(raw.mock.calls.map(call => call[0]).join('\n')).not.toMatch(/similarity|ILIKE|slug LIKE|people\//);
      expect(raw).toHaveBeenCalledTimes(2);
    } finally { aliases.mockRestore(); raw.mockRestore(); }
  });
});

async function judge(fact: string, subject: string, resolved?: string[]) {
  __setChatTransportForTests(async () => ({ text: JSON.stringify({ subjects: [{ i: 0, subject }] }), blocks: [], stopReason: 'end',
    usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 }, model: 'anthropic:claude-haiku-4-5', providerId: 'anthropic' }) as never);
  return (await judgeBatch(engine, 'default', 'anthropic:claude-haiku-4-5', [{ id: 1, fact, resolved }]))[0]!;
}

describe('Japanese model subject quotation', () => {
  test('independent topic/subject particles admit the complete registered name', async () => {
    for (const fact of ['Atlas は更新した', 'Atlasは更新した', 'Atlasが更新した', '田中は更新した', '田中が更新した', 'Atlasは公開しました。', 'Atlasは更新している']) {
      expect(await judge(fact, fact.startsWith('田中') ? '田中' : 'Atlas')).toEqual({ id: 1, slug: 'projects/atlas-example' });
    }
  });
  test('longer names and unproved particle sequences remain rejected', async () => {
    for (const fact of ['Atlasはるか', 'Atlasがく', 'Atlasはる株式会社', 'Atlasの更新', 'Atlasについて更新した', 'Atlasには更新がある', 'xAtlasは更新した', 'Atlasplusは更新した']) {
      expect(await judge(fact, 'Atlas')).toMatchObject({ slug: null, reason: 'unverified_match' });
    }
    for (const fact of ['田中はるか', '田中はる子', '田中がく', '田中はる株式会社', '山田田中は更新した']) {
      expect(await judge(fact, '田中')).toMatchObject({ slug: null, reason: 'unverified_match' });
    }
  });
  test('longer names segmented at particles reject with or without a registered longer alias', async () => {
    const cases = [['田中が島は更新した', '田中', '田中が島'], ['Atlasが原は更新した', 'Atlas', 'Atlasが原'],
      ['田中が岳登山口は閉鎖', '田中', '田中が岳登山口']];
    for (const [fact, subject, longer] of cases) {
      expect(await judge(fact!, subject!)).toMatchObject({ slug: null, reason: 'unverified_match' });
      await page('projects/longer-example', [longer!]);
      expect(await judge(fact!, subject!)).toMatchObject({ slug: null, reason: 'unverified_match' });
    }
  });
  test('unsupported predicates and trailing clauses abstain', async () => {
    for (const fact of ['Atlasは帰った', 'Atlasは閉鎖', 'Atlasは更新した後に移動した', 'Atlasは更新した。田中は公開した', 'Atlasは更新した追加']) {
      expect(await judge(fact, 'Atlas')).toMatchObject({ slug: null, reason: 'unverified_match' });
    }
  });
  test('combining marks and astral letters cannot become false name boundaries', async () => {
    for (const fact of ['Atlaś 更新した', '́Atlas 更新した', '𐐀Atlas 更新した', 'Atlas𐐀 更新した', 'Atlasは́更新した']) {
      expect(await judge(fact, 'Atlas')).toMatchObject({ slug: null, reason: 'unverified_match' });
    }
  });
  test('quotation support does not bypass the existing deterministic target restriction', async () => {
    expect(await judge('Atlasは更新した', 'Atlas', ['projects/vertex-example'])).toMatchObject({ slug: null, reason: 'ambiguous' });
    expect(await judge('Atlasは更新した', 'Missing Example')).toMatchObject({ slug: null, reason: 'unverified_match' });
  });
  test('unavailable or failing segmentation preserves strict spaced behavior', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(Intl, 'Segmenter')!;
    try {
      Object.defineProperty(Intl, 'Segmenter', { ...descriptor, value: undefined });
      expect(await judge('Atlasは更新した', 'Atlas')).toMatchObject({ slug: null, reason: 'unverified_match' });
      expect(await judge('Atlas は更新した', 'Atlas')).toMatchObject({ slug: 'projects/atlas-example' });
      Object.defineProperty(Intl, 'Segmenter', { ...descriptor, value: class { constructor() { throw new Error('unavailable dictionary'); } } });
      expect(await judge('Atlasは更新した', 'Atlas')).toMatchObject({ slug: null, reason: 'unverified_match' });
    } finally { Object.defineProperty(Intl, 'Segmenter', descriptor); }
  });
});
