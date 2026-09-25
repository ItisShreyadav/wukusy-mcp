#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import * as cheerio from 'cheerio';
import { Wukusy, listPage, parseCards, readInputs, parseMaybeJson, mask, PROFILE_FIELDS, SENSITIVE_FIELDS } from './client.mjs';

const client = new Wukusy();
const server = new McpServer({ name: 'wukusy', version: '0.1.0' });

const ok = (data) => ({ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] });
const fail = (err) => ({ isError: true, content: [{ type: 'text', text: err.message || String(err) }] });
const wrap = (fn) => async (args) => { try { return ok(await fn(args)); } catch (e) { return fail(e); } };

// Every write tool takes confirm/dry_run. dry_run returns the exact request without
// sending it; a real send needs confirm: true so a call can't come from a guessed argument list.
const guard = {
  confirm: z.boolean().default(false).describe('Must be true to actually send. Only set after the user has explicitly approved this exact change.'),
  dry_run: z.boolean().default(false).describe('Preview the exact request without sending it.'),
};
const write = (fn) => async ({ confirm, dry_run, ...args }) => {
  if (!dry_run && confirm !== true) return fail(new Error('Not sent: pass confirm: true after the user approves, or dry_run: true to preview the request.'));
  const w = {
    post: (path, data, opts = {}) => client.post(path, data, { ...opts, dryRun: dry_run }),
    postMultipart: (path, fd) => client.postMultipart(path, fd, { dryRun: dry_run }),
  };
  try { return ok(await fn(args, w)); } catch (e) { return fail(e); }
};
const WRITE = 'WRITES to the live Wukusy account. Get explicit user approval for the exact values before calling.';
const MONEY = 'MOVES MONEY. Never call without the user explicitly approving the exact amount in this conversation.';

const dateRange = z.string().optional().describe('Date filter as the site expects it, MM-DD-YYYY or a range "MM-DD-YYYY to MM-DD-YYYY", e.g. "09-01-2026 to 09-25-2026".');
const pageArg = z.number().int().min(1).optional().describe('Page number (1-based).');

const dmy = (iso) => { const [y, m, d] = iso.split('-').map(Number); return `${d}-${m}-${y}`; };
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');

// ---------- Read tools ----------

server.registerTool('get_analytics', {
  description: 'Order counts and profit for the currently selected store over a date range: all/draft/confirmed/RTO/shipped/delivered/cancelled/NDR orders, gross profit and upcoming estimated profit.',
  inputSchema: { start: isoDate.describe('Start date YYYY-MM-DD'), end: isoDate.describe('End date YYYY-MM-DD') },
}, wrap(async ({ start, end }) => {
  const $ = await client.html('/dropshiper/crm', { start: dmy(start), end: dmy(end) });
  return { start, end, metrics: parseCards($) };
}));

const ORDER_VIEWS = {
  all: '/dropshiper/allOrders', draft: '/dropshiper/orders', confirmed: '/dropshiper/orderConfirm',
  shipped: '/dropshiper/orderShipped', closed: '/dropshiper/orderClosed',
};

server.registerTool('list_orders', {
  description: 'List orders for the selected store. view picks the tab; order_status narrows within "all" (e.g. rto, delivered, cancelled, in_transit, out_for_delivery, failed_delivery).',
  inputSchema: {
    view: z.enum(Object.keys(ORDER_VIEWS)).default('all'),
    order_status: z.string().optional(),
    search: z.string().optional().describe('Wukusy id, Shopify order number, customer, etc.'),
    order_date: dateRange,
    payment_type: z.enum(['prepaid', 'cod']).optional(),
    page: pageArg,
  },
}, wrap(({ view, order_status, search, order_date, payment_type, page }) =>
  listPage(client, ORDER_VIEWS[view], { order_status, search, order_date, payment_type, page })));

server.registerTool('list_profit', {
  description: 'Per-order profit. kind "realized" is settled profit; "estimated" is upcoming estimated profit on open orders.',
  inputSchema: { kind: z.enum(['realized', 'estimated']).default('realized'), search: z.string().optional(), order_date: dateRange, payment_type: z.enum(['prepaid', 'cod']).optional(), page: pageArg },
}, wrap(({ kind, search, order_date, payment_type, page }) =>
  listPage(client, kind === 'realized' ? '/dropshiper/profit' : '/dropshiper/estimated_profit', { search, order_date, payment_type, page })));

server.registerTool('list_ndr', {
  description: 'Orders with a failed delivery attempt (NDR) awaiting action.',
  inputSchema: { search: z.string().optional(), order_date: dateRange, page: pageArg },
}, wrap(({ search, order_date, page }) => listPage(client, '/dropshiper/tracking', { search, order_date, page })));

server.registerTool('get_wallet', {
  description: 'Wallet ledger: opening balance, debits, credits, running balance, narration.',
  inputSchema: { order: z.string().optional().describe('Filter by order id'), page: pageArg },
}, wrap(({ order, page }) => listPage(client, '/dropshiper/wallet', { order, page })));

server.registerTool('list_products', {
  description: 'Products imported to the selected store.',
  inputSchema: { page: pageArg },
}, wrap(({ page }) => listPage(client, '/dropshiper/products', { page })));

server.registerTool('list_wishlist', {
  description: 'Wishlist products (candidates to push to Shopify).',
  inputSchema: { page: pageArg },
}, wrap(({ page }) => listPage(client, '/dropshiper/wishlist', { page })));

server.registerTool('search', {
  description: 'Quick search (header search box): returns matching catalog items with their SKU. Use search_catalog to get product_ids for pushing/wishlisting.',
  inputSchema: { q: z.string() },
}, wrap(async ({ q }) => {
  const $ = cheerio.load(await client.get('/dropshiper/searchApi', { q }));
  return $('a.search-result-item').toArray().map((a) => ({
    name: $(a).find('.search-result-name').text().trim(),
    sku: new URL($(a).attr('href'), 'https://wukusy.app').searchParams.get('q'),
    image: $(a).find('img').attr('src'),
  }));
}));

// Catalog cards carry the numeric product id in their pushToShopify(N) button.
server.registerTool('search_catalog', {
  description: 'Search the Wukusy supplier catalog. Returns product_id (for push_to_shopify / add_to_wishlist / get_catalog_product), name, cost price, image.',
  inputSchema: { q: z.string().describe('Keyword or SKU'), page: pageArg },
}, wrap(async ({ q, page }) => {
  const $ = await client.html('/dropshiper/find', { q, page });
  return $('button[onclick*="pushToShopify("]').toArray().map((b) => {
    const id = $(b).attr('onclick').match(/pushToShopify\((\d+)\)/)?.[1];
    let card = $(b).parent();
    while (card.length && !card.find('img').length) card = card.parent();
    return { product_id: id, name: card.find('.p-name').text().trim(), cost_price: card.find('p.card-text').first().text().trim(), image: card.find('img').attr('src') };
  }).filter((p) => p.product_id);
}));

server.registerTool('get_catalog_product', {
  description: 'Name and base Wukusy price of a catalog product (the site computes shipping/tax in the browser, so those are not available here).',
  inputSchema: { product_id: z.string() },
}, wrap(async ({ product_id }) => {
  const $ = await client.html(`/dropshiper/load-product/${encodeURIComponent(product_id)}`);
  $('script,style').remove();
  return { product_id, details: $.root().text().replace(/\s+/g, ' ').trim().slice(0, 2000) };
}));

server.registerTool('list_stores', {
  description: 'Connected Shopify stores and which one is the current default (all other tools act on the default).',
  inputSchema: {},
}, wrap(async () => {
  const $ = await client.html('/dropshiper/analytics');
  return $('#storeSelect option').toArray().map((o) => ({ id: $(o).attr('value'), name: $(o).text().trim(), selected: $(o).is('[selected]') }));
}));

server.registerTool('get_profile', {
  description: 'Account profile incl. bank details (bank name, account holder, account number, IFSC), PAN, Aadhaar and GST info. Sensitive numbers are masked unless reveal is true.',
  inputSchema: { reveal: z.boolean().default(false).describe('Return full account/PAN/Aadhaar/GST numbers. Only when the user asks to see them.') },
}, wrap(async ({ reveal }) => {
  const { byName } = await readInputs(client, '/dropshiper/setting');
  const out = { email: byName.email };
  for (const f of PROFILE_FIELDS) if (f !== 'new_password') out[f] = reveal || !SENSITIVE_FIELDS.includes(f) ? byName[f] : mask(byName[f]);
  for (const f of ['bank_proof', 'pan_proof', 'aadhar_proof', 'gst_certificate', 'store_logo']) out[f] = byName[f];
  return out;
}));

server.registerTool('get_page', {
  description: 'Escape hatch: GET any /dropshiper/* page and return its tables and pagination. Use when no dedicated tool fits.',
  inputSchema: { path: z.string().regex(/^\/dropshiper\/[\w\-/]*$/), query: z.record(z.string(), z.string()).optional() },
}, wrap(({ path, query }) => listPage(client, path, query)));

// ---------- Order writes ----------

server.registerTool('confirm_orders', {
  description: `Confirm draft orders so Wukusy fulfils them (debits wallet). ${WRITE}`,
  inputSchema: { order_ids: z.array(z.string()).min(1), ...guard },
}, write(({ order_ids }, w) => w.post('/merchant/bulkNewOrder', { order_ids: order_ids.join(','), status: 'confirmed' })));

server.registerTool('cancel_orders', {
  description: `Cancel orders. ${WRITE}`,
  inputSchema: { order_ids: z.array(z.string()).min(1), ...guard },
}, write(({ order_ids }, w) => w.post('/merchant/bulkCancelOrder', { order_ids, status: 'Cancelled-New' })));

server.registerTool('edit_shipping_address', {
  description: `Edit an order's shipping address. fields are the order's address form fields (read them from the order first). ${WRITE}`,
  inputSchema: { fields: z.record(z.string(), z.string()), ...guard },
}, write(({ fields }, w) => w.post('/dropshiper/editSaveAddress', fields, { json: true })));

server.registerTool('update_ndr', {
  description: `Respond to a failed delivery (NDR): e.g. re-attempt, change address/phone, or RTO. ${WRITE}`,
  inputSchema: { order_id: z.string(), action_type: z.string().describe('NDR action type value as used on the Manage NDR page'), note: z.string().default(''), ...guard },
}, write(({ order_id, action_type, note }, w) => w.post('/dropshiper/update-ndr', { id: order_id, ndr_action: note, ndr_action_type: action_type })));

// ---------- Product / wishlist writes ----------

server.registerTool('push_to_shopify', {
  description: `Publish a Wukusy product to a Shopify store at a sell price. ${WRITE}`,
  inputSchema: { product_id: z.string(), sell_price: z.number().positive(), store_id: z.string(), ...guard },
}, write(({ product_id, sell_price, store_id }, w) => w.post('/dropshiper/pushToShopify', { storeId: store_id, sellPrice: sell_price, productId: product_id })));

server.registerTool('bulk_push_to_shopify', {
  description: `Publish several wishlist items to a Shopify store. ${WRITE}`,
  inputSchema: { wishlist_ids: z.array(z.string()).min(1), store_id: z.string(), ...guard },
}, write(({ wishlist_ids, store_id }, w) => w.post('/dropshiper/bulkPushToShopify', { selected: wishlist_ids, storeId: store_id })));

server.registerTool('add_to_wishlist', {
  description: `Add a catalog product to the wishlist. ${WRITE}`,
  inputSchema: { product_id: z.string(), ...guard },
}, write(({ product_id }, w) => w.post('/dropshiper/addWishlist', { productId: product_id })));

server.registerTool('add_category_to_wishlist', {
  description: `Add every product in a catalog category to the wishlist. ${WRITE}`,
  inputSchema: { category_id: z.string(), ...guard },
}, write(({ category_id }, w) => w.post('/dropshiper/pushWishlist', { cat_id: category_id })));

server.registerTool('update_wishlist_price', {
  description: `Set the sell price of one wishlist item. ${WRITE}`,
  inputSchema: { wishlist_id: z.string(), sell_price: z.number().positive(), store_id: z.string(), ...guard },
}, write(({ wishlist_id, sell_price, store_id }, w) => w.post('/dropshiper/updateWishlist', { id: wishlist_id, sellPrice: sell_price, storeId: store_id })));

server.registerTool('bulk_markup_wishlist', {
  description: `Apply a percentage markup to several wishlist items. ${WRITE}`,
  inputSchema: { wishlist_ids: z.array(z.string()).min(1), store_id: z.string(), percent: z.number(), ...guard },
}, write(({ wishlist_ids, store_id, percent }, w) => w.post('/dropshiper/bulkUpdateWishlist', { selected: wishlist_ids, storeId: store_id, percetenge: percent })));

server.registerTool('delete_wishlist_item', {
  description: `Remove an item from the wishlist. ${WRITE}`,
  inputSchema: { id: z.string(), uuid: z.string(), product_id: z.string(), ...guard },
}, write(({ id, uuid, product_id }, w) => w.post('/dropshiper/deleteWishlist', { id, uuid, product_id })));

server.registerTool('add_to_cart', {
  description: `Add a product to the Wukusy cart at a manual price. ${WRITE}`,
  inputSchema: { product_id: z.string(), manual_price: z.number().positive(), ...guard },
}, write(({ product_id, manual_price }, w) => w.post('/dropshiper/addToCart', { productId: product_id, manual_price })));

server.registerTool('delete_product', {
  description: `Delete an imported product from Wukusy AND from the Shopify store. Not reversible. Take id/uuid/shopify_product_id from list_products row _ids (id, sid, shopify). ${WRITE}`,
  inputSchema: { id: z.string(), uuid: z.string(), shopify_product_id: z.string(), ...guard },
}, write(({ id, uuid, shopify_product_id }, w) => w.post('/merchant/deleteProduct', { id, uuid, shopify_product_id })));

// ---------- Store / account writes ----------

server.registerTool('change_default_store', {
  description: `Switch the account's default store (all read tools then show that store). ${WRITE}`,
  inputSchema: { store_id: z.string().describe('Store id from list_stores'), ...guard },
}, write(({ store_id }, w) => w.post('/dropshiper/changeDefaultStore', { storeId: store_id })));

server.registerTool('update_store_gst', {
  description: `Update the store name and GST city/state shown in the store details dialog. ${WRITE}`,
  inputSchema: { store_name: z.string(), gst_city: z.string(), gst_state: z.string(), ...guard },
}, write((a, w) => w.post('/dropshiper/updateStore', { store_name: a.store_name, gst_city: a.gst_city, gst_state: a.gst_state })));

server.registerTool('rename_store', {
  description: `Rename a connected store. ${WRITE}`,
  inputSchema: { store_uuid: z.string(), store_name: z.string(), ...guard },
}, write(({ store_uuid, store_name }, w) => w.post('/merchant/updateStoreName', { uuid: store_uuid, store_name })));

server.registerTool('install_store', {
  description: `Start connecting a new Shopify store (xxx.myshopify.com). The response may contain a Shopify install URL the user must open. ${WRITE}`,
  inputSchema: { store_url: z.string(), ...guard },
}, write(({ store_url }, w) => w.post('/merchant/install', { store_url })));

// updateProfile always sends the full profile, so unspecified fields are filled from
// the current values; otherwise the server would blank them.
async function updateProfile(changes, w) {
  const { byName } = await readInputs(client, '/dropshiper/setting');
  const body = {};
  for (const f of PROFILE_FIELDS) body[f] = f in changes ? changes[f] : (f === 'new_password' ? '' : byName[f] ?? '');
  const res = await w.post('/dropshiper/updateProfile', body);
  return { changed: Object.keys(changes).map((k) => (SENSITIVE_FIELDS.includes(k) ? `${k} (${mask(changes[k])})` : k)), response: res };
}

server.registerTool('update_profile', {
  description: `Update profile/KYC fields (name, mobile, PAN, Aadhaar, GST details). Unspecified fields keep their current values. ${WRITE}`,
  inputSchema: {
    changes: z.object({
      name: z.string(), mobile: z.string(), account_pan: z.string(), aadhar_number: z.string(),
      gst_name: z.string(), account_trade: z.string(), account_gst: z.string(), gst_address: z.string(),
      gst_city: z.string(), gst_state: z.string(), gst_pincode: z.string(),
    }).partial().refine((o) => Object.keys(o).length > 0, 'Provide at least one field'),
    ...guard,
  },
}, write(({ changes }, w) => updateProfile(changes, w)));

server.registerTool('update_bank_details', {
  description: `Change the payout bank account (bank name, holder name, account number, IFSC). Withdrawals go to this account. ${WRITE}`,
  inputSchema: {
    bank_name: z.string().optional(), account_name: z.string().optional(),
    account_number: z.string().regex(/^\d{6,20}$/).optional(), account_ifsc: z.string().regex(/^[A-Z]{4}0[A-Z0-9]{6}$/, 'IFSC like HDFC0001234').optional(),
    ...guard,
  },
}, write((changes, w) => {
  if (!Object.keys(changes).length) throw new Error('Provide at least one bank field to change.');
  return updateProfile(changes, w);
}));

server.registerTool('upload_document', {
  description: `Upload a KYC/branding file from disk. type: gst (certificate), bank (proof), pan, aadhar, or logo. Returns the stored file URL; pass it to the matching *_proof field. ${WRITE}`,
  inputSchema: { file_path: z.string(), type: z.string(), ...guard },
}, write(async ({ file_path, type }, w) => {
  const page = await client.get('/dropshiper/setting');
  const userId = page.match(/append\(\s*['"]user_id['"]\s*,\s*['"]?(\d+)/)?.[1];
  if (!userId) throw new Error('Could not find user_id on the settings page.');
  const fd = new FormData();
  fd.append('file', new Blob([await readFile(file_path)]), basename(file_path));
  fd.append('type', type);
  fd.append('user_id', userId);
  return w.postMultipart('/dropshiper/fileUpload', fd);
}));

server.registerTool('create_ticket', {
  description: `Open a Wukusy support ticket. ${WRITE}`,
  inputSchema: { subject: z.string(), message: z.string(), ticket_type: z.string().describe('Ticket category as shown on the Support page'), ...guard },
}, write(({ subject, message, ticket_type }, w) => w.post('/dropshiper/create_ticket', { subject, message, ticket_type })));

// ---------- Money ----------

server.registerTool('recharge_wallet', {
  description: `Create a wallet top-up for an amount in INR. Returns a payment link the user must open and pay themselves; nothing is charged by this call alone. ${MONEY}`,
  inputSchema: { amount_inr: z.number().int().positive(), ...guard },
}, write(async ({ amount_inr }, w) => {
  const res = await w.post('/dropshiper/rechargeWallet', { amount: amount_inr });
  return res.dry_run ? res : res.uuid ? { status: res.status, pay_url: `https://wukusy.app/dropshiper/payNow/${res.uuid}` } : res;
}));

server.registerTool('withdraw_wallet', {
  description: `Request a wallet withdrawal in INR to the saved bank account (see get_profile). ${MONEY}`,
  inputSchema: { amount_inr: z.number().positive(), aadhar_gst: z.string().default('').describe('GST number for the withdrawal, if applicable'), ...guard },
}, write(async ({ amount_inr, aadhar_gst }, w) => {
  const { byId } = await readInputs(client, '/dropshiper/wallet');
  const saved = (k) => byId[`wd_${k}_saved`] || byId[`wd_${k}`] || '';
  const body = {
    amount: amount_inr, aadhar_gst,
    bank_name: saved('bank_name'), account_name: saved('account_name'), account_number: saved('account_number'),
    account_ifsc: saved('account_ifsc'), account_pan: saved('account_pan'), aadhar_number: saved('aadhar_number'),
    bank_proof: byId.wd_bank_proof || '', pan_proof: byId.wd_pan_proof || '', aadhar_proof: byId.wd_aadhar_proof || '',
  };
  const missing = Object.entries(body).filter(([k, v]) => k !== 'aadhar_gst' && !v).map(([k]) => k);
  if (missing.length) throw new Error(`Saved bank/KYC details are incomplete (${missing.join(', ')}). Fix them with update_bank_details / update_profile / upload_document first.`);
  const res = await w.post('/dropshiper/walletWithdraw', body);
  return { requested_inr: amount_inr, to_account: `${body.bank_name} ${mask(body.account_number)}`, response: res };
}));

await server.connect(new StdioServerTransport());
