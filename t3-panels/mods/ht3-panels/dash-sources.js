// Where a Dashboard widget's data comes from (dashboard.js asks, dash-data.js shapes it).
// Every source only reads. source: { type, … }; ctx: { prometheus: the dashboard's server, if it names one }.

// "static": the data is in the file itself ({ type: "static", data }). For trying a widget out.
async function fromStatic(s) {
  if (!("data" in s)) throw new Error('A "static" source needs "data"');
  return s.data;
}

const SOURCES = { static: fromStatic };
export const SOURCE_TYPES = Object.keys(SOURCES);

export async function fetchSource(source, ctx = {}) {
  const get = SOURCES[source?.type];
  if (!get) throw new Error(source?.type ? `No source type "${source.type}" (there are: ${SOURCE_TYPES.join(", ")})` : "This widget has no source");
  return get(source, ctx);
}
