/**
 * LND data collector for self-attestation.
 * 
 * Calls the LND REST API via the lncli.sh wrapper to gather
 * real metrics for publishing as a self-attestation.
 * 
 * SECURITY: Only uses read-only endpoints. Never exposes
 * macaroons, private keys, or raw financial data in output.
 */

import { execSync } from 'child_process';

const LNCLI = '/data/.openclaw/workspace/lncli.sh';

function lndCall(endpoint, method = 'GET', body = null) {
  let cmd = `bash ${LNCLI} ${endpoint}`;
  if (method !== 'GET') cmd += ` -X ${method}`;
  if (body) cmd += ` -d '${JSON.stringify(body)}'`;
  
  const result = execSync(cmd, { encoding: 'utf8', timeout: 15000 });
  return JSON.parse(result);
}

/**
 * Collect metrics from LND for self-attestation.
 * Returns only aggregate/derived metrics, never raw data.
 */
export async function collectLndMetrics() {
  // Get node info
  const info = lndCall('/v1/getinfo');
  
  // Get channel balances
  const channelBalance = lndCall('/v1/balance/channels');
  
  // Get channels
  const channelsResp = lndCall('/v1/channels');
  const channels = channelsResp.channels || [];
  
  // Get payment history (for success rate)
  const payments = lndCall('/v1/payments');
  const paymentList = payments.payments || [];
  
  // Get forwarding history
  const fwdResp = lndCall('/v1/switch', 'POST', {
    start_time: '0',
    end_time: String(Math.floor(Date.now() / 1000)),
    index_offset: 0,
    num_max_events: 1000,
  });
  const forwards = fwdResp.forwarding_events || [];
  
  // Compute metrics
  const totalCapacity = channels.reduce((sum, ch) => sum + parseInt(ch.capacity || '0'), 0);
  const numActiveChannels = channels.filter(ch => ch.active).length;
  
  // Payment success rate
  const succeeded = paymentList.filter(p => p.status === 'SUCCEEDED').length;
  const failed = paymentList.filter(p => p.status === 'FAILED').length;
  const totalPayments = succeeded + failed;
  const paymentSuccessRate = totalPayments > 0 ? succeeded / totalPayments : 0;
  
  // Uptime: average across channels (uptime/lifetime ratio)
  let uptimePercent = 0;
  if (channels.length > 0) {
    const uptimeRatios = channels.map(ch => {
      const uptime = parseInt(ch.uptime || '0');
      const lifetime = parseInt(ch.lifetime || '1');
      return lifetime > 0 ? uptime / lifetime : 0;
    });
    uptimePercent = (uptimeRatios.reduce((a, b) => a + b, 0) / uptimeRatios.length) * 100;
  }
  
  // Settlement rate (all invoices that were created vs settled)
  // For now, use payment success rate as proxy
  const settlementRate = paymentSuccessRate;
  
  return {
    pubkey: info.identity_pubkey,
    alias: info.alias,
    version: info.version,
    syncedToChain: info.synced_to_chain,
    syncedToGraph: info.synced_to_graph,
    blockHeight: parseInt(info.block_height || '0'),
    
    // Dimensions for attestation
    dimensions: {
      payment_success_rate: {
        value: paymentSuccessRate.toFixed(4),
        sampleSize: totalPayments,
      },
      settlement_rate: {
        value: settlementRate.toFixed(4),
        sampleSize: totalPayments,
      },
      uptime_percent: {
        value: uptimePercent.toFixed(1),
        sampleSize: channels.length,
      },
      capacity_sats: {
        value: String(totalCapacity),
        sampleSize: numActiveChannels,
      },
      num_channels: {
        value: String(numActiveChannels),
        sampleSize: 1,
      },
      num_forwards: {
        value: String(forwards.length),
        sampleSize: 1,
      },
    },
    
    // Metadata (not published, just for logging)
    _meta: {
      totalPayments,
      succeeded,
      failed,
      numChannels: channels.length,
      numActiveChannels,
      totalCapacity,
      forwardingEvents: forwards.length,
    },
  };
}
