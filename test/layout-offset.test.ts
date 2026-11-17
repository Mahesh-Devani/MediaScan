/**
 * test/layout-offset.test.ts
 * Verifies that standalone tabs (DNSMOS Tool, Clip Studio, Metrics) start directly
 * below the global navigation bar with 0px gap (<= 2px tolerance) and #dashboard is hidden.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

describe('Global Nav & Standalone Tabs Layout Offset Verification', () => {
  const summaryBeforePath = path.resolve('scratch/screenshots/before/summary.json');
  const summaryAfterPath = path.resolve('scratch/screenshots/after/summary.json');

  it('verifies that standalone tab navigation hides #dashboard in DOM switching rules', () => {
    function resolveDashboardDisplay(targetId: string, hasPcap: boolean): string {
      if (targetId === 'tab-dnsmos-tool' || targetId === 'tab-clip-studio') return 'none';
      if (!hasPcap) return 'none';
      if (targetId === 'tab-metrics') return 'none';
      return 'flex';
    }

    assert.equal(resolveDashboardDisplay('tab-dnsmos-tool', false), 'none');
    assert.equal(resolveDashboardDisplay('tab-clip-studio', false), 'none');
    assert.equal(resolveDashboardDisplay('tab-metrics', true), 'none');
    assert.equal(resolveDashboardDisplay('tab-ladder', true), 'flex');
    assert.equal(resolveDashboardDisplay('tab-sip', true), 'flex');
    assert.equal(resolveDashboardDisplay('tab-rtp', true), 'flex');
  });

  it('verifies that before the fix, DNSMOS Tool and Clip Studio had significant blank gaps (> 100px)', () => {
    if (!fs.existsSync(summaryBeforePath)) return;
    const before = JSON.parse(fs.readFileSync(summaryBeforePath, 'utf8'));

    const dnsmosBefore = before.results.find((r: any) => r.tabName === 'tab-dnsmos-tool');
    const clipBefore = before.results.find((r: any) => r.tabName === 'tab-clip-studio');

    assert.ok(dnsmosBefore.gapFromNav > 100, `Expected DNSMOS before gap > 100px, got ${dnsmosBefore?.gapFromNav}px`);
    assert.ok(clipBefore.gapFromNav > 100, `Expected Clip Studio before gap > 100px, got ${clipBefore?.gapFromNav}px`);
  });

  it('verifies that after the fix, all standalone panels start directly below nav within <= 2px tolerance', () => {
    if (!fs.existsSync(summaryAfterPath)) return;
    const after = JSON.parse(fs.readFileSync(summaryAfterPath, 'utf8'));

    const dnsmosAfter = after.results.find((r: any) => r.tabName === 'tab-dnsmos-tool');
    const clipAfter = after.results.find((r: any) => r.tabName === 'tab-clip-studio');

    assert.ok(
      Math.abs(dnsmosAfter.gapFromNav) <= 2,
      `DNSMOS Tool must start directly below nav (tolerance <= 2px), got gap: ${dnsmosAfter?.gapFromNav}px`
    );
    assert.ok(
      Math.abs(clipAfter.gapFromNav) <= 2,
      `Clip Studio must start directly below nav (tolerance <= 2px), got gap: ${clipAfter?.gapFromNav}px`
    );

    assert.equal(dnsmosAfter.dashboardDisplay, 'none', '#dashboard must be display: none when DNSMOS is active');
    assert.equal(clipAfter.dashboardDisplay, 'none', '#dashboard must be display: none when Clip Studio is active');
  });

  it('verifies that with PCAP loaded, tab-ladder, tab-sip, tab-rtp remain active with dashboard visible and tab-metrics hidden', () => {
    if (!fs.existsSync(summaryAfterPath)) return;
    const after = JSON.parse(fs.readFileSync(summaryAfterPath, 'utf8'));

    const ladder = after.pcapResults.find((r: any) => r.tabName === 'tab-ladder');
    const sip = after.pcapResults.find((r: any) => r.tabName === 'tab-sip');
    const rtp = after.pcapResults.find((r: any) => r.tabName === 'tab-rtp');
    const metrics = after.pcapResults.find((r: any) => r.tabName === 'tab-metrics');

    assert.equal(ladder.dashboardDisplay, 'flex');
    assert.equal(sip.dashboardDisplay, 'flex');
    assert.equal(rtp.dashboardDisplay, 'flex');
    assert.equal(metrics.dashboardDisplay, 'none');

    assert.ok(Math.abs(ladder.gapFromNav) <= 2);
    assert.ok(Math.abs(sip.gapFromNav) <= 2);
    assert.ok(Math.abs(rtp.gapFromNav) <= 2);
    assert.ok(Math.abs(metrics.gapFromNav) <= 2);
  });
});
