// ESLint flat config — hace cumplir las fronteras de la arquitectura hexagonal.
// El dominio es puro y los packages NO acoplan el SDK de Catalyst; el HTTP externo
// (CRM, Creator, WorkDrive) vive SOLO en packages/providers.
import tsparser from "@typescript-eslint/parser";

export default [
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "apps/catalyst/functions/*/index.js",
      "apps/catalyst/functions/*/index.js.map",
      "**/*.tsbuildinfo",
    ],
  },
  {
    files: ["**/*.ts"],
    languageOptions: { parser: tsparser, ecmaVersion: 2023, sourceType: "module" },
    rules: {},
  },
  // Ningún package acopla el SDK de Catalyst (tipado estructural — el wiring real lo inyecta la función).
  {
    files: ["packages/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "zcatalyst-sdk-node",
              message: "Los packages no importan el SDK de Catalyst: el wiring concreto lo inyecta la función.",
            },
          ],
        },
      ],
    },
  },
  // HTTP externo SOLO en packages/providers: ningún `fetch` fuera de los adapters
  // (CRM, Zoho Creator y WorkDrive se hablan únicamente desde providers).
  {
    files: [
      "packages/domain/**/*.ts",
      "packages/persistence/**/*.ts",
      "packages/application/**/*.ts",
      "apps/catalyst/functions/**/*.ts",
    ],
    rules: {
      "no-restricted-globals": [
        "error",
        { name: "fetch", message: "HTTP externo solo en packages/providers (adapters). El resto usa los puertos." },
      ],
    },
  },
  // El dominio es puro: no conoce otras capas ni la plataforma (hexagonal).
  {
    files: ["packages/domain/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            { name: "zcatalyst-sdk-node", message: "El dominio no conoce la plataforma." },
            { name: "express", message: "El dominio no conoce el transporte HTTP." },
          ],
          patterns: [
            {
              group: ["@cardoc/providers", "@cardoc/persistence", "@cardoc/application"],
              message: "El dominio no importa otras capas (regla hexagonal).",
            },
          ],
        },
      ],
    },
  },
];
