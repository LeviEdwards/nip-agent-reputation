/**
 * run-monitoring.js — Entry point for recurring monitoring cycle.
 * 
 * Ensures registry exists, initializes it if needed, then runs the
 * full monitoring cycle (probe all endpoints + publish attestations).
 * 
 * Also handles order fulfillment: scans for paid unfulfilled orders.
 * 
 * Usage:
 *   node src/run-monitoring.js                  # Full cycle
 *   node src/run-monitoring.js --dry-run        # Probe only
 *   node src/run-monitoring.js --orders-only    # Only check orders
 *   node src/run-monitoring.js --monitor-only   # Only monitor
 */

import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { runMonitoringCycle, initRegistry } from './monitor.js';
import { scanAndFulfill } from './fulfill.js';
import { runBillingCycle, getBillingStatus } from './billing.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');
const REGISTRY_PATH = join(DATA_DIR, 'monitor-registry.json');

// Order directories
const LOCAL_ORDERS_DIR = join(DATA_DIR, 'pending-orders');

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const ordersOnly = args.includes('--orders-only');
  const monitorOnly = args.includes('--monitor-only');
  
  console.log(`\n========================================`);
  console.log(`  NIP-30386 Monitoring Cycle`);
  console.log(`  ${new Date().toISOString()}`);
  console.log(`  ${dryRun ? '(DRY RUN)' : '(LIVE)'}`);
  console.log(`========================================\n`);
  
  // 1. Ensure registry exists
  if (!existsSync(REGISTRY_PATH)) {
    console.log('No registry found — initializing with default endpoints...');
    initRegistry(REGISTRY_PATH);
  }
  
  // 2. Check for unfulfilled orders (unless --monitor-only)
  if (!monitorOnly) {
    console.log('\n--- Order Fulfillment Check ---');
    try {
      // Check local pending-orders directory
      if (existsSync(LOCAL_ORDERS_DIR)) {
        const result = await scanAndFulfill(LOCAL_ORDERS_DIR, { dryRun });
        if (result.fulfilled > 0) {
          console.log(`  Fulfilled ${result.fulfilled} new order(s)!`);
        }
      } else {
        console.log('  No local orders directory.');
      }
    } catch (err) {
      console.error(`  Order check error: ${err.message}`);
    }
  }
  
  // 3. Run monitoring cycle (unless --orders-only)
  if (!ordersOnly) {
    console.log('\n--- Endpoint Monitoring ---');
    try {
      const result = await runMonitoringCycle({
        dryRun,
        registryPath: REGISTRY_PATH,
      });
      
      if (result.error) {
        console.error(`  Monitoring error: ${result.error}`);
      } else {
        console.log(`\n  Monitoring complete: ${result.published} attestations published, ${result.probed} endpoints probed.`);
      }
    } catch (err) {
      console.error(`  Monitoring error: ${err.message}`);
    }
  }
  
  // 4. Run billing cycle (unless --orders-only or --monitor-only)
  if (!ordersOnly && !monitorOnly) {
    console.log('\n--- Billing Check ---');
    try {
      const status = getBillingStatus();
      if (status.totalAccounts > 0) {
        console.log(`  ${status.totalAccounts} billing accounts (${status.active} active, MRR: ${status.monthlyRecurring} sats)`);
        const actions = await runBillingCycle({ dryRun });
        if (actions.invoicesGenerated > 0 || actions.accountsSuspended > 0) {
          console.log(`  Actions: ${actions.invoicesGenerated} invoices, ${actions.accountsSuspended} suspensions`);
        }
      } else {
        console.log('  No billing accounts yet.');
      }
    } catch (err) {
      console.error(`  Billing error: ${err.message}`);
    }
  }
  
  console.log(`\n========================================`);
  console.log(`  Cycle complete: ${new Date().toISOString()}`);
  console.log(`========================================\n`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
