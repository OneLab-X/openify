/**
 * Couriers staff can pick for a manual "courier with AWB" fulfillment, with a tracking-link
 * builder for each (ported and extended from PLS `src/lib/delivery.ts`).
 */
export interface KnownCourier {
  id: string;
  name: string;
  country: string | null;
  trackingUrl: (awb: string) => string;
}

const enc = encodeURIComponent;

export const KNOWN_COURIERS: readonly KnownCourier[] = [
  { id: "delhivery", name: "Delhivery", country: "IN", trackingUrl: (a) => `https://www.delhivery.com/track/package/${enc(a)}` },
  { id: "bluedart", name: "Blue Dart", country: "IN", trackingUrl: (a) => `https://www.bluedart.com/web/guest/trackdartresult?trackFor=0&trackNo=${enc(a)}` },
  { id: "dtdc", name: "DTDC", country: "IN", trackingUrl: (a) => `https://www.dtdc.in/trace.asp?strCnno=${enc(a)}` },
  { id: "ekart", name: "Ekart", country: "IN", trackingUrl: (a) => `https://ekartlogistics.com/shipmenttrack/${enc(a)}` },
  { id: "xpressbees", name: "XpressBees", country: "IN", trackingUrl: (a) => `https://www.xpressbees.com/shipment/tracking?awbNo=${enc(a)}` },
  { id: "shadowfax", name: "Shadowfax", country: "IN", trackingUrl: (a) => `https://tracker.shadowfax.in/#/track/${enc(a)}` },
  { id: "indiapost", name: "India Post", country: "IN", trackingUrl: (a) => `https://www.indiapost.gov.in/_layouts/15/dop.portal.tracking/trackconsignment.aspx?consignment=${enc(a)}` },
  { id: "shiprocket", name: "Shiprocket", country: "IN", trackingUrl: (a) => `https://shiprocket.co/tracking/${enc(a)}` },
  { id: "dhl", name: "DHL Express", country: null, trackingUrl: (a) => `https://www.dhl.com/global-en/home/tracking/tracking-express.html?tracking-id=${enc(a)}` },
  { id: "fedex", name: "FedEx", country: null, trackingUrl: (a) => `https://www.fedex.com/fedextrack/?trknbr=${enc(a)}` },
  { id: "ups", name: "UPS", country: null, trackingUrl: (a) => `https://www.ups.com/track?tracknum=${enc(a)}` },
  { id: "usps", name: "USPS", country: "US", trackingUrl: (a) => `https://tools.usps.com/go/TrackConfirmAction?tLabels=${enc(a)}` },
  { id: "aramex", name: "Aramex", country: null, trackingUrl: (a) => `https://www.aramex.com/track/results?ShipmentNumber=${enc(a)}` },
];

export function courierTrackingUrl(courierId: string, awb: string): string | null {
  const c = KNOWN_COURIERS.find((k) => k.id === courierId);
  return c && awb.trim() ? c.trackingUrl(awb.trim()) : null;
}
