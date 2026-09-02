import { a as archivedFlights } from '../../../chunks/archive_Ct518Mef.mjs';
export { renderers } from '../../../renderers.mjs';

async function getStaticPaths() {
  return (await archivedFlights()).map(({ archive }) => ({
    params: { id: archive.flight_id },
    props: { archive }
  }));
}
const GET = ({ props }) => new Response(JSON.stringify(props.archive, null, 1), {
  headers: { "Content-Type": "application/json" }
});

const _page = /*#__PURE__*/Object.freeze(/*#__PURE__*/Object.defineProperty({
  __proto__: null,
  GET,
  getStaticPaths
}, Symbol.toStringTag, { value: 'Module' }));

const page = () => _page;

export { page };
