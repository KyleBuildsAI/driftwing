// On-screen UI of the dev test harnesses: a progress pill while a test runs and a summary panel
// (overall PASS / FAIL, the criteria, result tables and a JSON report download) when it ends. Both
// use the v1 glass style and live in #ui-root.
import './testPanel.css';

const STATUS_CLASS = Object.freeze({ pass: 'dw-test-pass-text', fail: 'dw-test-fail-text', info: '', muted: 'dw-test-muted-text' });

function element(tag, className = '', text = null) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== null && text !== undefined) node.textContent = String(text);
  return node;
}

function button(label, onClick, solid = false) {
  const node = element('button', `dw-text-button${solid ? ' dw-solid' : ''}`, label);
  node.type = 'button';
  node.addEventListener('click', (event) => {
    event.stopPropagation();
    onClick();
  });
  return node;
}

/** Starts a browser download of text as a file. */
export function downloadText(filename, text, type = 'application/json') {
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([text], { type }));
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 4000);
}

/** A table cell value: plain text, or { text, status: 'pass'|'fail'|'muted', wrap, numeric }. */
function fillCell(cell, value, column) {
  const spec = value !== null && typeof value === 'object' ? value : { text: value };
  cell.textContent = spec.text === null || spec.text === undefined ? '-' : String(spec.text);
  if (spec.status && STATUS_CLASS[spec.status]) cell.classList.add(STATUS_CLASS[spec.status]);
  if (spec.wrap || column.wrap) cell.classList.add('dw-test-wrap');
  if (column.numeric) cell.classList.add('dw-test-num');
  if (spec.title) cell.title = spec.title;
}

function buildTable({ columns, rows, footer = null }) {
  const table = element('table', 'dw-test-table');
  const head = table.createTHead().insertRow();
  for (const column of columns) {
    const cell = element('th', column.numeric ? 'dw-test-num' : '', column.label);
    if (column.title) cell.title = column.title;
    head.append(cell);
  }
  const body = table.createTBody();
  for (const row of rows) {
    const tableRow = body.insertRow();
    for (const column of columns) fillCell(tableRow.insertCell(), row[column.key], column);
  }
  if (footer) {
    const foot = table.createTFoot().insertRow();
    for (const column of columns) fillCell(foot.insertCell(), footer[column.key], column);
  }
  return table;
}

/**
 * Creates the harness UI inside #ui-root. title: the harness name shown on the pill and the panel.
 * Returns { setProgress, showSummary, hideProgress }.
 */
export function createTestPanel({ title }) {
  const root = document.getElementById('ui-root') ?? document.body;

  const progress = element('div', 'dw-test-progress glass');
  progress.setAttribute('role', 'status');
  progress.setAttribute('aria-live', 'polite');
  const progressTitle = element('span', 'dw-micro dw-gold', title);
  const progressLabel = element('div', 'dw-test-progress-label', 'Starting');
  const progressDetail = element('div', 'dw-test-progress-detail', '');
  const progressBar = element('div', 'dw-test-progress-bar');
  const progressFill = element('span');
  progressBar.append(progressFill);
  progress.append(progressTitle, progressLabel, progressDetail, progressBar);
  root.append(progress);

  const summary = element('section', 'dw-test-summary glass');
  summary.hidden = true;
  summary.setAttribute('aria-label', `${title} results`);
  root.append(summary);

  return {
    /** Updates the progress pill: label (what runs now), detail (second line), fraction 0..1. */
    setProgress({ label, detail = '', fraction = null }) {
      progress.hidden = false;
      progressLabel.textContent = label;
      progressDetail.textContent = detail;
      progressFill.style.width = Number.isFinite(fraction) ? `${Math.round(Math.min(Math.max(fraction, 0), 1) * 1000) / 10}%` : '0%';
    },

    hideProgress() {
      progress.hidden = true;
    },

    /**
     * Shows the summary panel.
     *   result: 'PASS' | 'FAIL'; subtitle: one line under the title
     *   meta: [[label, value]]; criteria: [{ label, value, status }]
     *   sections: [{ title, table: { columns: [{ key, label, numeric?, wrap?, title? }], rows, footer? } | notes: [text] }]
     *   report + filename: the JSON offered by the download button; actions: [{ label, onClick }]
     */
    showSummary({ result, subtitle = '', meta = [], criteria = [], sections = [], report, filename, actions = [] }) {
      progress.hidden = true;
      summary.replaceChildren();
      const head = element('header', 'dw-test-head');
      const verdict = element('div', `dw-test-verdict ${result === 'PASS' ? 'dw-test-pass' : 'dw-test-fail'}`, result);
      const heading = element('div');
      heading.append(element('span', 'dw-micro dw-gold', 'Dev verification'), element('h2', '', title), element('div', 'dw-test-subtitle', subtitle));
      const headActions = element('div', 'dw-test-head-actions');
      headActions.append(button('Download JSON report', () => downloadText(filename, JSON.stringify(report, null, 2)), true));
      for (const action of actions) headActions.append(button(action.label, action.onClick));
      head.append(verdict, heading, headActions);

      const body = element('div', 'dw-test-body');
      if (meta.length > 0) {
        const metaRow = element('div', 'dw-test-meta');
        for (const [label, value] of meta) {
          const item = element('span', '', `${label} `);
          item.append(element('b', '', value));
          metaRow.append(item);
        }
        body.append(metaRow);
      }
      if (criteria.length > 0) {
        const section = element('div', 'dw-test-section');
        section.append(element('h3', 'dw-micro', 'Pass criteria'));
        const grid = element('div', 'dw-test-criteria');
        for (const criterion of criteria) {
          const card = element('div', 'dw-test-criterion');
          card.append(element('div', 'dw-test-criterion-label', criterion.label), element('div', `dw-test-criterion-value ${STATUS_CLASS[criterion.status] ?? ''}`, criterion.value));
          grid.append(card);
        }
        section.append(grid);
        body.append(section);
      }
      for (const entry of sections) {
        const section = element('div', 'dw-test-section');
        section.append(element('h3', 'dw-micro', entry.title));
        if (entry.table) section.append(buildTable(entry.table));
        if (entry.notes) {
          const list = element('ul', 'dw-test-notes');
          for (const note of entry.notes) list.append(element('li', '', note));
          section.append(list);
        }
        body.append(section);
      }
      summary.append(head, body);
      summary.hidden = false;
    },
  };
}
