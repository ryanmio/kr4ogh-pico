import { a as createComponent, r as renderComponent, d as renderTemplate, m as maybeRenderHead } from '../chunks/astro/server_DdaXy4vm.mjs';
import 'piccolore';
import { l as liveFlights, t as trackFor, $ as $$FlightLive } from '../chunks/flights_yVldiayO.mjs';
import { $ as $$Base } from '../chunks/render_lAijmlJF.mjs';
export { renderers } from '../renderers.mjs';

const $$Index = createComponent(($$result, $$props, $$slots) => {
  const flight = liveFlights()[0];
  const track = flight ? trackFor(flight.flight_id) : [];
  return renderTemplate`${flight ? renderTemplate`${renderComponent($$result, "Base", $$Base, { "title": "KR4OGH \u2014 live balloon telemetry", "chrome": false }, { "default": ($$result2) => renderTemplate`${renderComponent($$result2, "FlightLive", $$FlightLive, { "flight": flight, "track": track })}` })}` : renderTemplate`${renderComponent($$result, "Base", $$Base, { "title": "KR4OGH \u2014 live balloon telemetry" }, { "default": ($$result2) => renderTemplate`${maybeRenderHead()}<div class="notice notice-accent">Nothing in the air right now.</div>` })}`}`;
}, "/vercel/sandbox/primary/site/src/pages/index.astro", void 0);

const $$file = "/vercel/sandbox/primary/site/src/pages/index.astro";
const $$url = "";

const _page = /*#__PURE__*/Object.freeze(/*#__PURE__*/Object.defineProperty({
  __proto__: null,
  default: $$Index,
  file: $$file,
  url: $$url
}, Symbol.toStringTag, { value: 'Module' }));

const page = () => _page;

export { page };
