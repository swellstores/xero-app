/**
 * Orders in the shape the Swell API returns them, trimmed to the fields the app reads.
 * New Zealand orders charge 15 % GST on prices before tax unless they say otherwise.
 */

const nzCustomer = {
  account_id: "6ad0000000000000000000a1",
  account: { id: "6ad0000000000000000000a1", email: "olivia@example.com", name: "Olivia Moore" },
  billing: {
    name: "Olivia Moore",
    first_name: "Olivia",
    last_name: "Moore",
    address1: "12 Ponsonby Road",
    city: "Auckland",
    state: "Auckland",
    zip: "1011",
    country: "NZ",
    phone: "+64 21 555 0101",
  },
  shipping: {
    name: "Olivia Moore",
    address1: "12 Ponsonby Road",
    city: "Auckland",
    zip: "1011",
    country: "NZ",
    service_name: "NZ Post Courier",
  },
};

/** Tax on prices before tax that Xero's rounding gives exactly */
export const simple = {
  id: "6ad000000000000000000001",
  number: "1001",
  currency: "NZD",
  ...nzCustomer,
  item_tax_included: false,
  shipment_tax_included: false,
  sub_total: 40,
  shipment_price: 5,
  shipment_tax: 0.75,
  tax_total: 6.75,
  grand_total: 51.75,
  paid: true,
  // 22:30 UTC on the 12th is the 13th in Auckland
  date_created: "2026-10-12T22:30:00.000Z",
  taxes: [{ id: "gst", name: "GST", rate: 15, amount: 6.75, shipping: true }],
  items: [
    {
      id: "item-1",
      product_name: "Linen Tee",
      variant_name: "Natural / M",
      sku: "LT-NAT-M",
      quantity: 2,
      price: 20,
      price_total: 40,
      discount_total: 0,
      tax_total: 6,
      taxes: [{ id: "gst", amount: 6 }],
      delivery: "shipment",
    },
  ],
};

/** Tax that Swell rounds once and Xero per line: a cent apart before tax, exact with tax included */
export const oddCents = {
  id: "6ad000000000000000000002",
  number: "1002",
  currency: "NZD",
  ...nzCustomer,
  item_tax_included: false,
  shipment_tax_included: false,
  sub_total: 87.47,
  shipment_price: 6,
  shipment_tax: 0.9,
  tax_total: 14.0205,
  grand_total: 107.49,
  paid: true,
  date_created: "2026-10-12T09:00:00.000Z",
  taxes: [{ id: "gst", name: "GST", rate: 15, amount: 14.0205, shipping: true }],
  items: [
    { id: "item-1", product_name: "Wool Socks", quantity: 3, price: 24.99, price_total: 74.97, discount_total: 0, tax_total: 11.2455, taxes: [{ id: "gst" }], delivery: "shipment" },
    { id: "item-2", product_name: "Enamel Mug", quantity: 1, price: 12.5, price_total: 12.5, discount_total: 0, tax_total: 1.875, taxes: [{ id: "gst" }], delivery: "shipment" },
  ],
};

/** A coupon on prices before tax */
export const discounted = {
  id: "6ad000000000000000000003",
  number: "1003",
  currency: "NZD",
  ...nzCustomer,
  item_tax_included: false,
  shipment_tax_included: false,
  sub_total: 100,
  discount_total: 10,
  shipment_price: 0,
  tax_total: 13.5,
  grand_total: 103.5,
  coupon_code: "SPRING10",
  paid: true,
  date_created: "2026-10-12T09:00:00.000Z",
  taxes: [{ id: "gst", name: "GST", rate: 15, amount: 13.5 }],
  items: [
    { id: "item-1", product_name: "Rain Jacket", quantity: 2, price: 50, price_total: 100, discount_total: 10, tax_total: 13.5, taxes: [{ id: "gst" }], delivery: "shipment" },
  ],
};

/** A store with prices including tax */
export const taxIncluded = {
  id: "6ad000000000000000000004",
  number: "1004",
  currency: "NZD",
  ...nzCustomer,
  item_tax_included: true,
  shipment_tax_included: true,
  sub_total: 23,
  shipment_price: 0,
  tax_total: 3,
  grand_total: 23,
  paid: true,
  date_created: "2026-10-12T09:00:00.000Z",
  taxes: [{ id: "gst", name: "GST", rate: 15, amount: 3 }],
  items: [{ id: "item-1", product_name: "Tote Bag", quantity: 1, price: 23, price_total: 23, discount_total: 0, tax_total: 3, taxes: [{ id: "gst" }], delivery: "shipment" }],
};

/** An export: no tax charged */
export const untaxed = {
  id: "6ad000000000000000000005",
  number: "1005",
  currency: "NZD",
  account_id: "6ad0000000000000000000b2",
  account: { id: "6ad0000000000000000000b2", email: "noah@example.com", name: "Noah Smith" },
  billing: { name: "Noah Smith", address1: "1 Market St", city: "Sydney", zip: "2000", country: "AU" },
  shipping: { name: "Noah Smith", address1: "1 Market St", city: "Sydney", zip: "2000", country: "AU" },
  item_tax_included: false,
  shipment_tax_included: false,
  sub_total: 50,
  shipment_price: 0,
  tax_total: 0,
  grand_total: 50,
  paid: true,
  date_created: "2026-10-12T09:00:00.000Z",
  taxes: [],
  items: [{ id: "item-1", product_name: "Linen Tee", quantity: 1, price: 50, price_total: 50, discount_total: 0, tax_total: 0, delivery: "shipment" }],
};

/** A US order with California sales tax, shipping not taxed */
export const unitedStates = {
  id: "6ad000000000000000000006",
  number: "1006",
  currency: "USD",
  account_id: "6ad0000000000000000000c3",
  account: { id: "6ad0000000000000000000c3", email: "ava@example.com", name: "Ava Johnson" },
  billing: { name: "Ava Johnson", company: "Johnson Design", address1: "500 Market St", city: "San Francisco", state: "CA", zip: "94105", country: "US" },
  shipping: { name: "Ava Johnson", address1: "500 Market St", city: "San Francisco", state: "CA", zip: "94105", country: "US", service_name: "UPS Ground" },
  item_tax_included: false,
  shipment_tax_included: false,
  sub_total: 100,
  shipment_price: 10,
  shipment_tax: 0,
  tax_total: 8.25,
  grand_total: 118.25,
  paid: true,
  date_created: "2026-10-12T09:00:00.000Z",
  taxes: [{ id: "ca", name: "CA Sales Tax", rate: 8.25, amount: 8.25 }],
  items: [{ id: "item-1", product_name: "Desk Lamp", quantity: 1, price: 100, price_total: 100, discount_total: 0, tax_total: 8.25, taxes: [{ id: "ca" }], delivery: "shipment" }],
};

/** Not paid yet: bank transfer */
export const unpaid = {
  ...simple,
  id: "6ad000000000000000000007",
  number: "1007",
  paid: false,
};

/** A free sticker next to a taxed item: the free line carries no tax of its own */
export const freeItem = {
  ...simple,
  id: "6ad000000000000000000008",
  number: "1008",
  items: [
    ...simple.items,
    { id: "item-2", product_name: "Sticker", quantity: 1, price: 0, price_total: 0, discount_total: 0, tax_total: 0, delivery: "shipment" },
  ],
};
