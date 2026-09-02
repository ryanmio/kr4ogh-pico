import { c as createAstro, a as createComponent, r as renderComponent, b as renderScript, d as renderTemplate, m as maybeRenderHead, e as addAttribute, u as unescapeHTML, F as Fragment } from '../../chunks/astro/server_DdaXy4vm.mjs';
import 'piccolore';
import { r as renderEntry, a as archivedFlights } from '../../chunks/archive_Ct518Mef.mjs';
import { w as withBase, r as resolveTrackSpeeds, s as statsHtml, t as tableHtml, $ as $$Base, o as outcomeBadgeClass } from '../../chunks/render_lAijmlJF.mjs';
export { renderers } from '../../renderers.mjs';

const $$Astro = createAstro("https://kr4ogh-pico.vercel.app");
async function getStaticPaths() {
  return (await archivedFlights()).map((flight) => ({
    params: { id: flight.archive.flight_id },
    props: { flight }
  }));
}
const $$Index = createComponent(async ($$result, $$props, $$slots) => {
  const Astro2 = $$result.createAstro($$Astro, $$props, $$slots);
  Astro2.self = $$Index;
  const { flight } = Astro2.props;
  const { entry, archive } = flight;
  const { Content } = await renderEntry(entry);
  const trackUrl = withBase(`/flights/${archive.flight_id}/track.json`);
  const track = resolveTrackSpeeds(archive.track);
  const stats = statsHtml(track);
  const table = tableHtml(track);
  return renderTemplate`${renderComponent($$result, "Base", $$Base, { "title": `${entry.data.title} \u2014 KR4OGH`, "description": entry.data.summary }, { "default": async ($$result2) => renderTemplate` ${maybeRenderHead()}<div class="flight-title-row"> <h1>${entry.data.title}</h1> <span${addAttribute(["badge", outcomeBadgeClass(entry.data.outcome)], "class:list")}> ${entry.data.outcome} </span> </div> <p class="flight-subtitle"> ${archive.callsign} · ${archive.band} · channel ${archive.channel} · ${entry.data.period} </p> <div id="map"${addAttribute(trackUrl, "data-track-url")}></div> <div class="fv-stats">${unescapeHTML(stats)}</div> <div id="charts"></div> ${renderComponent($$result2, "Fragment", Fragment, {}, { "default": async ($$result3) => renderTemplate`${unescapeHTML(table)}` })} <div class="flight-notes prose"> ${renderComponent($$result2, "Content", Content, {})} </div> <p class="toolbar"> <a class="button"${addAttribute(trackUrl, "href")}${addAttribute(`${archive.flight_id}.json`, "download")}>Download track.json</a> </p> ` })} ${renderScript($$result, "/vercel/sandbox/primary/site/src/pages/flights/[id]/index.astro?astro&type=script&index=0&lang.ts")}`;
}, "/vercel/sandbox/primary/site/src/pages/flights/[id]/index.astro", void 0);

const $$file = "/vercel/sandbox/primary/site/src/pages/flights/[id]/index.astro";
const $$url = "/flights/[id]";

const _page = /*#__PURE__*/Object.freeze(/*#__PURE__*/Object.defineProperty({
  __proto__: null,
  default: $$Index,
  file: $$file,
  getStaticPaths,
  url: $$url
}, Symbol.toStringTag, { value: 'Module' }));

const page = () => _page;

export { page };
