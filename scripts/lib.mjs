import { appendFileSync } from 'node:fs';

const API = process.env.GITHUB_API_URL || 'https://api.github.com';
export const repo = process.env.GITHUB_REPOSITORY;

export async function gh(path, { method = 'GET', body, accept, raw } = {}) {
  const res = await fetch(path.startsWith('http') ? path : `${API}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${process.env.GH_TOKEN}`,
      accept: accept || 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'wasm-bindgen-bot',
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (raw) return res;
  if (!res.ok) {
    throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
  }
  return res.status === 204 ? null : res.json();
}

// GraphQL reports the app as `wasm-bindgen-bot`, REST as `wasm-bindgen-bot[bot]`.
export const isBot = login => login?.replace(/\[bot\]$/, '') === 'wasm-bindgen-bot';

export async function graphql(query, variables) {
  const { data, errors } = await gh('/graphql', { method: 'POST', body: { query, variables } });
  if (errors) throw new Error(`GraphQL: ${JSON.stringify(errors)}`);
  return data;
}

export async function reviewThreads(number) {
  const [owner, name] = repo.split('/');
  const threads = [];
  let cursor = null;
  do {
    const data = await graphql(
      `query($owner: String!, $name: String!, $number: Int!, $cursor: String) {
        repository(owner: $owner, name: $name) {
          pullRequest(number: $number) {
            reviewThreads(first: 100, after: $cursor) {
              pageInfo { hasNextPage endCursor }
              nodes {
                id isResolved isOutdated path line originalLine
                comments(first: 50) { nodes { author { login } body } }
              }
            }
          }
        }
      }`,
      { owner, name, number, cursor }
    );
    const page = data.repository.pullRequest.reviewThreads;
    threads.push(...page.nodes);
    cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (cursor);
  return threads;
}

export async function paginate(path, limit = Infinity) {
  const out = [];
  let url = `${API}${path}${path.includes('?') ? '&' : '?'}per_page=100`;
  while (url && out.length < limit) {
    const res = await gh(url, { raw: true });
    if (!res.ok) throw new Error(`GET ${url}: ${res.status} ${await res.text()}`);
    out.push(...(await res.json()));
    url = /<([^>]+)>;\s*rel="next"/.exec(res.headers.get('link') || '')?.[1];
  }
  return out.slice(0, limit);
}

export async function fileAt(path, ref) {
  const res = await gh(
    `/repos/${repo}/contents/${path}?ref=${encodeURIComponent(ref)}`,
    { raw: true, accept: 'application/vnd.github.raw+json' }
  );
  return res.ok ? res.text() : null;
}

export function setOutput(name, value) {
  appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

export function summary(text) {
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, text + '\n');
  }
}

// Lines on the new side of each hunk, which are the only ones a review
// comment can anchor to.
export function commentableLines(patch) {
  const lines = new Set();
  let n = 0;
  for (const l of (patch || '').split('\n')) {
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(l);
    if (h) n = +h[1];
    else if (l[0] === '+' || l[0] === ' ') lines.add(n++);
  }
  return lines;
}
