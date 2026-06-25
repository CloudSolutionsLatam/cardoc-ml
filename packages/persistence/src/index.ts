/**
 * @cardoc/persistence — modelo de datos (tipos de fila) + puertos de repositorio.
 *
 * No importa el SDK de Catalyst: la implementación DataStore-backed se inyecta desde
 * la función (mantiene el dominio testeable sin plataforma).
 */
export * from "./entities";
export * from "./repositories";
export * from "./memory";
export * from "./catalyst";
