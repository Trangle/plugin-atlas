import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';

const css = await readFile(new URL('./public/style.css', import.meta.url), 'utf8');
const renderer = (await readFile(new URL('./public/branch-graph-view.js', import.meta.url), 'utf8')).replace(
  /export \{ renderBranchGraph, dateLabel \};\s*$/,
  '',
);
const panel = (await readFile(new URL('../dsh-plugin/client/src/index.jsx', import.meta.url), 'utf8')).match(
  /export const styles = `([\s\S]*?)`;/,
)[1];
const graph = {
  family: 'layout',
  lanes: 2,
  rows: 2,
  edges: [],
  nodes: [
    {
      id: 'a',
      label: 'A very long branch name that should remain centered and never wrap onto another line',
      role: 'trunk',
      lane: 0,
      row: 0,
      time: 1700000000000,
      unique: ['tag'],
    },
    {
      id: 'b',
      label: 'Another very long branch name that exceeds the previous narrow column width',
      role: 'branch',
      lane: 1,
      row: 1,
      time: 1700000000000,
      plus: 3,
      minus: 1,
      unique: ['tag'],
    },
  ],
};

test('web and panel labels stay aligned and single-line', async () => {
  const browser = await chromium.launch({
    executablePath: '/usr/bin/google-chrome',
    headless: true,
    args: ['--no-sandbox'],
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    for (const compact of [false, true]) {
      await page.setContent(
        `<style>${compact ? panel : css}</style><main class="${compact ? 'atlas-root graph-mode' : 'graph-mode'}"><div id="graph" class="atlas-graph" style="width:${compact ? 340 : 1200}px"></div></main>`,
      );
      await page.addScriptTag({ content: `{ ${renderer} window.renderBranchGraph = renderBranchGraph; }` });
      await page.evaluate(
        ({ graph, compact }) =>
          renderBranchGraph(document.querySelector('#graph'), graph, { compact, hideTags: compact }),
        { graph, compact },
      );
      const rows = await page.locator('.bg-label').evaluateAll((labels) =>
        labels.map((label) => {
          const name = label.querySelector('.bg-name');
          const dot = document.querySelector(`circle[data-id="${label.dataset.id}"]`).getBoundingClientRect();
          const rect = label.getBoundingClientRect();
          return {
            height: label.clientHeight,
            offset: label.offsetHeight,
            nameHeight: name.getBoundingClientRect().height,
            whiteSpace: getComputedStyle(name).whiteSpace,
            title: name.title,
            center: Math.abs(dot.top + dot.height / 2 - rect.top - rect.height / 2),
            gap:
              label.querySelector('.bg-tags').getBoundingClientRect().left -
              label.querySelector('.bg-role-cell').getBoundingClientRect().right,
          };
        }),
      );
      for (const [i, row] of rows.entries()) {
        const height = compact ? 32 : 36;
        assert.equal(row.height, height);
        assert.equal(row.offset, height);
        assert.ok(row.nameHeight <= height);
        assert.equal(row.whiteSpace, 'nowrap');
        assert.equal(row.title, graph.nodes[i].label);
        assert.ok(row.center <= 1, `center difference ${row.center}`);
        if (!compact) assert.ok(row.gap < 24, `metadata gap ${row.gap}`);
      }
    }
  } finally {
    await browser.close();
  }
});
