// The removal is by the app, so its unlabeled event runs the bot, which turns
// auto-merge off until the new head is merge-ready and approved again.
import { readFileSync } from 'node:fs';
import { gh, repo, summary } from './lib.mjs';

const { number } = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')).pull_request;
const res = await gh(`/repos/${repo}/issues/${number}/labels/merge-ready`, { method: 'DELETE', raw: true });
if (res.ok) summary(`Removed merge-ready from #${number} while it's reviewed`);
else if (res.status !== 404) throw new Error(`Removing merge-ready from #${number}: ${res.status} ${await res.text()}`);
