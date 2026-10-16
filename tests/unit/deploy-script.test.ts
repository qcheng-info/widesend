import { describe, expect, it } from 'vitest';
import { deployTargets } from '../../scripts/deploy.mjs';

// Workers Builds deploys only the Worker its build is connected to (Wrangler refuses
// another name there), so a button copy's dashboard is deployed from a checkout.
describe('what npm run deploy deploys', () => {
  it('deploys the dashboard too from a checkout', () => {
    expect(deployTargets(true, {})).toEqual({ site: true, dashboard: true });
    expect(deployTargets(false, {})).toEqual({ site: true, dashboard: false });
  });
  it('deploys only the site in Workers Builds', () => {
    expect(deployTargets(true, { WORKERS_CI: '1' })).toEqual({ site: true, dashboard: false });
    expect(deployTargets(true, { WRANGLER_CI_MATCH_TAG: 'tag' })).toEqual({
      site: true,
      dashboard: false,
    });
  });
});
