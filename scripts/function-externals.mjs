// Fuente ÚNICA de los paquetes que el bundle NO inlina y se shippean como node_modules
// real en el function dir. Consumido por bundle-function.mjs (esbuild `external`) y por
// deploy-prep-sdk.mjs (materialización de archivos reales). Ver docs/decisions (ADR-0010).
//
// `zcatalyst-sdk-node` hace `require` dinámicos de sus submódulos (p.ej. `./zcql/zcql`) que
// esbuild no puede resolver estáticamente → no se puede inlinar. Va externalizado + shippeado.
export const EXTERNALS = ["zcatalyst-sdk-node"];
