import { c as createAstro, a as createComponent, r as renderComponent, d as renderTemplate } from '../../chunks/astro/server_DdaXy4vm.mjs';
import 'piccolore';
import { l as liveFlights, t as trackFor, $ as $$FlightLive } from '../../chunks/flights_yVldiayO.mjs';
import { $ as $$Base } from '../../chunks/render_lAijmlJF.mjs';
export { renderers } from '../../renderers.mjs';

const $$Astro = createAstro("https://kr4ogh-pico.vercel.app");
async function getStaticPaths() {
  return liveFlights().map((flight) => ({
    params: { id: flight.flight_id },
    props: { flight, track: trackFor(flight.flight_id) }
  }));
}
const $$id = createComponent(($$result, $$props, $$slots) => {
  const Astro2 = $$result.createAstro($$Astro, $$props, $$slots);
  Astro2.self = $$id;
  const { flight, track } = Astro2.props;
  return renderTemplate`${renderComponent($$result, "Base", $$Base, { "title": `${flight.callsign} ${flight.flight_id} \u2014 live balloon telemetry`, "description": `Live telemetry for ${flight.callsign} flight ${flight.flight_id}.`, "chrome": false }, { "default": ($$result2) => renderTemplate` ${renderComponent($$result2, "FlightLive", $$FlightLive, { "flight": flight, "track": track })} ` })}`;
}, "/vercel/sandbox/primary/site/src/pages/live/[id].astro", void 0);

const $$file = "/vercel/sandbox/primary/site/src/pages/live/[id].astro";
const $$url = "/live/[id]";

const _page = /*#__PURE__*/Object.freeze(/*#__PURE__*/Object.defineProperty({
  __proto__: null,
  default: $$id,
  file: $$file,
  getStaticPaths,
  url: $$url
}, Symbol.toStringTag, { value: 'Module' }));

const page = () => _page;

export { page };
