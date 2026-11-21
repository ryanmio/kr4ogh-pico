/** Where the reel's pictures of the planet come from. Plain strings, apart
 * from the scene, so that dev/reel.mjs can read them without loading
 * MapLibre. */

/** The planet from far off: NASA's Blue Marble, one cloudless picture of
 * the whole Earth with the sea floor shaded in. The site's own imagery
 * (lib/basemap.ts) is sharper close in, but from the height of a reel it
 * is a quilt: each zoom level of its ocean is a different blue, and a
 * view to the horizon shows several at once with their edges square. So
 * the reel draws this underneath and brings the site's imagery in over it
 * only once the camera is close enough to need the detail. */
export const MARBLE_URL = "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/"
  + "BlueMarble_ShadedRelief_Bathymetry/default/GoogleMapsCompatible_Level8/{z}/{y}/{x}.jpeg";

/** The Earth at night, as one picture: NASA's Black Marble, for the towns
 * on the dark side (sky.ts). NASA draws it to order and takes some twenty
 * seconds over it, so dev/reel.mjs keeps a copy and hands the reel that. */
export const LIGHTS_URL = "https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi?SERVICE=WMS"
  + "&REQUEST=GetMap&VERSION=1.3.0&LAYERS=VIIRS_Black_Marble&STYLES=&FORMAT=image/jpeg"
  + "&CRS=EPSG:4326&BBOX=-90,-180,90,180&WIDTH=8192&HEIGHT=4096";

export const CREDIT = "Imagery: NASA Blue Marble & Black Marble · Esri, Maxar, Earthstar Geographics";
