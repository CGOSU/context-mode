import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { mkdtempSync, writeFileSync, utimesSync, unlinkSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContentStore } from '../src/store.js';
import { searchAllSources } from '../src/search/unified.js';

describe('request-local file refresh', () => {
  let dir: string;
  let store: ContentStore;
  let path: string;
  const original = '# Navigation\nlegacytoken documents the original interface.\n';

  function change(content: string) {
    writeFileSync(path, content);
    const future = new Date(Date.now() + 60000);
    utimesSync(path, future, future);
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ctx-search-batch-'));
    store = new ContentStore(join(dir, 'index.db'));
    path = join(dir, 'guide.md');
    writeFileSync(path, original);
    store.index({ path, source: 'guide' });
  });
  afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

  test('all queries see refreshed content, retain refresh reporting, and the next request detects changes', () => {
    change('# Navigation\nfreshtoken and secondtoken describe the new interface.\n');
    const results = store.withSearchBatch(search => [search('freshtoken'), search('secondtoken')]);
    for (const rows of results) expect(rows[0].content).toContain('new interface');
    expect(store.lastRefreshCount).toBe(1);
    expect(store.searchWithFallback('legacytoken')).toEqual([]);

    change('# Navigation\nnextrequesttoken is available now.\n');
    const next = store.withSearchBatch(search => search('nextrequesttoken'));
    expect(next[0].content).toContain('available now');
    expect(store.lastRefreshCount).toBe(1);
  });

  test('unchanged hashes preserve metadata and remain searchable throughout the batch', () => {
    const meta = store.getSourceMeta('guide');
    change(original);
    const results = store.withSearchBatch(search => [search('legacytoken'), search('original')]);
    for (const rows of results) expect(rows[0].content).toContain('legacytoken');
    expect(store.getSourceMeta('guide')).toEqual(meta);
    expect(store.lastRefreshCount).toBe(0);
  });

  test('denied refreshes do not index changed bytes, and a later allowed request refreshes', () => {
    change('# Navigation\nrestrictednewtoken must not be read while denied.\n');
    store.setDenyChecker(() => true);
    const denied = store.withSearchBatch(search => [search('restrictednewtoken'), search('legacytoken')]);
    expect(denied[0]).toEqual([]);
    expect(denied[1][0].content).toContain('legacytoken'); // Existing cached-content contract.
    expect(store.lastRefreshCount).toBe(0);
    store.setDenyChecker(() => false);
    expect(store.withSearchBatch(search => search('restrictednewtoken'))[0].content).toContain('must not');
    expect(store.lastRefreshCount).toBe(1);
  });

  test('missing files preserve cached results and reappear on the next request', () => {
    unlinkSync(path);
    expect(store.withSearchBatch(search => search('legacytoken'))[0].content).toContain('original');
    expect(store.lastRefreshCount).toBe(0);
    change('# Navigation\nrestoredtoken is readable again.\n');
    expect(store.withSearchBatch(search => search('restoredtoken'))[0].content).toContain('readable again');
  });

  test('only the next request reads bytes changed after the batch refresh', () => {
    const results = store.withSearchBatch(search => {
      const first = search('legacytoken');
      change('# Navigation\nlaterchangetoken was written during the request.\n');
      return [first, search('legacytoken'), search('laterchangetoken')];
    });
    expect(results[0][0].content).toContain('original');
    expect(results[1][0].content).toContain('original');
    expect(results[2]).toEqual([]);
    expect(store.withSearchBatch(search => search('laterchangetoken'))[0].content).toContain('during');
  });

  test('non-regular file targets are not read and recovery remains visible', () => {
    unlinkSync(path);
    mkdirSync(path);
    expect(store.withSearchBatch(search => search('legacytoken'))[0].content).toContain('original');
    expect(store.lastRefreshCount).toBe(0);
    rmSync(path, { recursive: true });
    change('# Navigation\nregulartoken is readable again.\n');
    expect(store.withSearchBatch(search => search('regulartoken'))[0].content).toContain('readable again');
  });

  test('a callback cannot carry the refresh bypass into later work, including after failure', () => {
    let later!: ContentStore['searchWithFallback'];
    expect(() => store.withSearchBatch(search => { later = search; throw new Error('callback failed'); }))
      .toThrow('callback failed');
    change('# Navigation\nafterfailuretoken remains fresh.\n');
    expect(later('afterfailuretoken')[0].content).toContain('remains fresh');
    change('# Navigation\npublicsearchtoken also refreshes.\n');
    expect(store.searchWithFallback('publicsearchtoken')[0].content).toContain('also refreshes');
  });

  test.each(['relevance', 'timeline'] as const)('%s unified searches reuse the request search while retaining results', sort => {
    change('# Navigation\nunifiedfresh and unifiedsecond are current.\n');
    const results = store.withSearchBatch(search => ['unifiedfresh', 'unifiedsecond'].map(query =>
      searchAllSources({ query, limit: 3, store, search, sort, configDir: join(dir, 'empty-config') }),
    ));
    for (const rows of results) expect(rows[0].content).toContain('are current');
    expect(store.lastRefreshCount).toBe(1);
  });
});
