// KCode - Haskell Project Engine

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type HaskellProjectType = "api" | "cli" | "library" | "web" | "script";

interface HaskellConfig {
  name: string;
  type: HaskellProjectType;
  framework?: string;
  deps: Array<{ name: string; version: string }>;
}

function detectHaskellProject(msg: string): HaskellConfig {
  const lower = msg.toLowerCase();
  let type: HaskellProjectType = "api";
  let framework: string | undefined;
  const deps: Array<{ name: string; version: string }> = [];

  if (/\b(?:servant)\b/i.test(lower)) {
    type = "api";
    framework = "servant";
    deps.push(
      { name: "servant", version: ">=0.20" },
      { name: "servant-server", version: ">=0.20" },
      { name: "warp", version: ">=3.3" },
      { name: "aeson", version: ">=2.1" },
    );
  } else if (/\b(?:scotty)\b/i.test(lower)) {
    type = "api";
    framework = "scotty";
    deps.push(
      { name: "scotty", version: ">=0.22" },
      { name: "aeson", version: ">=2.1" },
      { name: "wai", version: ">=3.2" },
      { name: "containers", version: ">=0.6" },
      { name: "text", version: ">=2.0" },
    );
  } else if (/\b(?:warp)\b/i.test(lower)) {
    type = "api";
    framework = "warp";
    deps.push(
      { name: "warp", version: ">=3.3" },
      { name: "wai", version: ">=3.2" },
      { name: "aeson", version: ">=2.1" },
      { name: "http-types", version: ">=0.12" },
    );
  } else if (/\b(?:yesod)\b/i.test(lower)) {
    type = "web";
    framework = "yesod";
    deps.push(
      { name: "yesod", version: ">=1.6" },
      { name: "yesod-core", version: ">=1.6" },
      { name: "warp", version: ">=3.3" },
    );
  } else if (/\b(?:ihp)\b/i.test(lower)) {
    type = "web";
    framework = "ihp";
    deps.push({ name: "ihp", version: ">=1.0" });
  } else if (/\b(?:api|rest|server|http)\b/i.test(lower)) {
    type = "api";
    framework = "scotty";
    deps.push(
      { name: "scotty", version: ">=0.22" },
      { name: "aeson", version: ">=2.1" },
      { name: "wai", version: ">=3.2" },
      { name: "containers", version: ">=0.6" },
      { name: "text", version: ">=2.0" },
    );
  } else if (/\b(?:cli|command|tool|escript)\b/i.test(lower)) {
    type = "cli";
  } else if (/\b(?:lib|library|package|hackage)\b/i.test(lower)) {
    type = "library";
  } else if (/\b(?:script|runhaskell|runghc)\b/i.test(lower)) {
    type = "script";
  } else if (/\b(?:web|site|website|app)\b/i.test(lower)) {
    type = "web";
    framework = "yesod";
    deps.push(
      { name: "yesod", version: ">=1.6" },
      { name: "yesod-core", version: ">=1.6" },
      { name: "warp", version: ">=3.3" },
    );
  } else {
    framework = "scotty";
    deps.push(
      { name: "scotty", version: ">=0.22" },
      { name: "aeson", version: ">=2.1" },
      { name: "wai", version: ">=3.2" },
      { name: "containers", version: ">=0.6" },
      { name: "text", version: ">=2.0" },
    );
  }

  // Additional dependency detection
  if (/\b(?:aeson|json)\b/i.test(lower) && !deps.some((d) => d.name === "aeson"))
    deps.push({ name: "aeson", version: ">=2.1" });
  if (/\b(?:text|unicode)\b/i.test(lower)) deps.push({ name: "text", version: ">=2.0" });
  if (/\b(?:bytestring|binary)\b/i.test(lower))
    deps.push({ name: "bytestring", version: ">=0.11" });
  if (/\b(?:containers|map|set)\b/i.test(lower))
    deps.push({ name: "containers", version: ">=0.6" });
  if (/\b(?:mtl|monad|transformer)\b/i.test(lower)) deps.push({ name: "mtl", version: ">=2.3" });
  if (/\b(?:lens|optic)\b/i.test(lower)) deps.push({ name: "lens", version: ">=5.2" });
  if (
    /\b(?:optparse|argument|flag)\b/i.test(lower) &&
    !deps.some((d) => d.name === "optparse-applicative")
  )
    deps.push({ name: "optparse-applicative", version: ">=0.18" });
  if (/\b(?:http.?client|request|fetch)\b/i.test(lower))
    deps.push(
      { name: "http-client", version: ">=0.7" },
      { name: "http-client-tls", version: ">=0.3" },
    );
  if (/\b(?:postgres|postgresql|pg)\b/i.test(lower))
    deps.push({ name: "postgresql-simple", version: ">=0.7" });
  if (/\b(?:persistent|database|db|orm)\b/i.test(lower))
    deps.push(
      { name: "persistent", version: ">=2.14" },
      { name: "persistent-sqlite", version: ">=2.13" },
    );
  if (/\b(?:wai|middleware)\b/i.test(lower) && !deps.some((d) => d.name === "wai"))
    deps.push({ name: "wai", version: ">=3.2" });

  // CLI gets optparse by default
  if (type === "cli" && !deps.some((d) => d.name === "optparse-applicative")) {
    deps.push({ name: "optparse-applicative", version: ">=0.18" });
  }

  const nameMatch = msg.match(/(?:called|named|nombre)\s+(\w[\w-]*)/i);
  const name = nameMatch?.[1] ?? (type === "library" ? "mylib" : "myapp");

  return { name, type, framework, deps: dedup(deps) };
}

function dedup(
  deps: Array<{ name: string; version: string }>,
): Array<{ name: string; version: string }> {
  const seen = new Set<string>();
  return deps.filter((d) => {
    if (seen.has(d.name)) return false;
    seen.add(d.name);
    return true;
  });
}

interface GenFile {
  path: string;
  content: string;
  needsLlm: boolean;
}
export interface HaskellProjectResult {
  config: HaskellConfig;
  files: GenFile[];
  projectPath: string;
  prompt: string;
}

export function createHaskellProject(userRequest: string, cwd: string): HaskellProjectResult {
  const cfg = detectHaskellProject(userRequest);
  const files: GenFile[] = [];
  const mod = cap(cfg.name);

  // package.yaml (hpack format)
  const baseDeps = ["base >= 4.7 && < 5", ...cfg.deps.map((d) => `${d.name} ${d.version}`)];
  files.push({
    path: "package.yaml",
    content: `name: ${cfg.name}
version: 0.1.0.0
synopsis: ${cfg.type === "library" ? "A Haskell library" : "A Haskell " + cfg.type + (cfg.framework ? " (" + cfg.framework + ")" : "")}
license: MIT
author: ""
maintainer: ""

dependencies:
${baseDeps.map((d) => `  - ${d}`).join("\n")}

library:
  source-dirs: src
  exposed-modules:
    - Lib

executables:
  ${cfg.name}-exe:
    main: Main.hs
    source-dirs: app
    dependencies:
      - ${cfg.name}
    ghc-options:
      - -threaded
      - -rtsopts
      - -with-rtsopts=-N

tests:
  ${cfg.name}-test:
    main: Spec.hs
    source-dirs: test
    dependencies:
      - ${cfg.name}
      - hspec
    ghc-options:
      - -threaded
      - -rtsopts
      - -with-rtsopts=-N
`,
    needsLlm: false,
  });

  // stack.yaml
  files.push({
    path: "stack.yaml",
    content: `resolver: lts-22.7
packages:
  - .
extra-deps: []
`,
    needsLlm: false,
  });

  // Source code based on project type
  if (
    (cfg.type === "api" && cfg.framework === "scotty") ||
    (cfg.type === "api" && !cfg.framework)
  ) {
    files.push({
      path: "app/Main.hs",
      content: `{-# LANGUAGE OverloadedStrings #-}
{-# LANGUAGE DeriveGeneric #-}

module Main (main) where

import Web.Scotty
import Data.Aeson (ToJSON, FromJSON, object, (.=))
import Data.IORef
import Data.Map.Strict (Map)
import qualified Data.Map.Strict as Map
import Data.Text.Lazy (Text)
import qualified Data.Text.Lazy as T
import GHC.Generics (Generic)
import Control.Monad.IO.Class (liftIO)

data Item = Item
  { itemId :: Int
  , itemName :: Text
  , itemDescription :: Text
  } deriving (Show, Generic)

instance ToJSON Item
instance FromJSON Item

data CreateItem = CreateItem
  { createName :: Text
  , createDescription :: Text
  } deriving (Show, Generic)

instance FromJSON CreateItem

main :: IO ()
main = do
  store <- newIORef (Map.empty :: Map Int Item)
  nextId <- newIORef (1 :: Int)
  scotty 10080 $ do
    get "/health" $
      json $ object ["status" .= ("ok" :: String)]

    get "/api/items" $ do
      items <- liftIO $ readIORef store
      json $ Map.elems items

    get "/api/items/:id" $ do
      i <- captureParam "id"
      items <- liftIO $ readIORef store
      case Map.lookup i items of
        Just item -> json item
        Nothing -> do
          status status404
          json $ object ["error" .= ("Item not found" :: String)]

    post "/api/items" $ do
      body <- jsonData :: ActionM CreateItem
      if T.null (T.strip (createName body))
        then do
          status status400
          json $ object ["error" .= ("Name is required" :: String)]
        else do
          newId <- liftIO $ atomicModifyIORef' nextId (\\n -> (n + 1, n))
          let item = Item newId (createName body) (createDescription body)
          liftIO $ modifyIORef' store (Map.insert newId item)
          status status201
          json item

    put "/api/items/:id" $ do
      i <- captureParam "id"
      body <- jsonData :: ActionM CreateItem
      items <- liftIO $ readIORef store
      case Map.lookup i items of
        Nothing -> do
          status status404
          json $ object ["error" .= ("Item not found" :: String)]
        Just _ -> do
          if T.null (T.strip (createName body))
            then do
              status status400
              json $ object ["error" .= ("Name is required" :: String)]
            else do
              let updated = Item i (createName body) (createDescription body)
              liftIO $ modifyIORef' store (Map.insert i updated)
              json updated

    delete "/api/items/:id" $ do
      i <- captureParam "id"
      items <- liftIO $ readIORef store
      case Map.lookup i items of
        Nothing -> do
          status status404
          json $ object ["error" .= ("Item not found" :: String)]
        Just _ -> do
          liftIO $ modifyIORef' store (Map.delete i)
          status status204
          text ""
`,
      needsLlm: false,
    });

    files.push({
      path: "src/Lib.hs",
      content: `module Lib (appName) where

appName :: String
appName = "${cfg.name}"
`,
      needsLlm: false,
    });
  } else if (cfg.type === "api" && cfg.framework === "servant") {
    files.push({
      path: "app/Main.hs",
      content: `{-# LANGUAGE DataKinds #-}
{-# LANGUAGE TypeOperators #-}
{-# LANGUAGE OverloadedStrings #-}

module Main (main) where

import Network.Wai.Handler.Warp (run)
import Lib (app)

main :: IO ()
main = do
  putStrLn "Starting Servant on port 10080..."
  run 10080 app
`,
      needsLlm: true,
    });

    files.push({
      path: "src/Lib.hs",
      content: `{-# LANGUAGE DataKinds #-}
{-# LANGUAGE TypeOperators #-}
{-# LANGUAGE OverloadedStrings #-}
{-# LANGUAGE DeriveGeneric #-}

module Lib (app) where

import Servant
import Data.Aeson (ToJSON)
import GHC.Generics (Generic)

data HealthStatus = HealthStatus { status :: String } deriving (Generic)
instance ToJSON HealthStatus

type API = "health" :> Get '[JSON] HealthStatus

server :: Server API
server = return $ HealthStatus "ok"

api :: Proxy API
api = Proxy

app :: Application
app = serve api server
`,
      needsLlm: true,
    });
  } else if (cfg.type === "api" && cfg.framework === "warp") {
    files.push({
      path: "app/Main.hs",
      content: `{-# LANGUAGE OverloadedStrings #-}

module Main (main) where

import Network.Wai (Application, responseLBS)
import Network.Wai.Handler.Warp (run)
import Network.HTTP.Types (status200, hContentType)
import Data.Aeson (encode, object, (.=))
import Lib (appName)

main :: IO ()
main = do
  putStrLn $ "Starting " ++ appName ++ " on port 10080..."
  run 10080 app

app :: Application
app _req respond = respond $
  responseLBS status200 [(hContentType, "application/json")] $
    encode $ object ["status" .= ("ok" :: String)]
`,
      needsLlm: true,
    });

    files.push({
      path: "src/Lib.hs",
      content: `module Lib (appName) where

appName :: String
appName = "${cfg.name}"
`,
      needsLlm: false,
    });
  } else if (cfg.type === "cli") {
    files.push({
      path: "app/Main.hs",
      content: `module Main (main) where

import Options.Applicative
import Lib (run)

data Options = Options
  { optInput  :: String
  , optVerbose :: Bool
  } deriving (Show)

optionsParser :: Parser Options
optionsParser = Options
  <$> strArgument (metavar "INPUT" <> help "Input to process")
  <*> switch (long "verbose" <> short 'v' <> help "Enable verbose output")

main :: IO ()
main = do
  opts <- execParser (info (optionsParser <**> helper)
    (fullDesc <> progDesc "${cfg.name}" <> header "${cfg.name} - a Haskell CLI tool"))
  Lib.run (optInput opts) (optVerbose opts)
`,
      needsLlm: true,
    });

    files.push({
      path: "src/Lib.hs",
      content: `module Lib (run) where

run :: String -> Bool -> IO ()
run input verbose = do
  if verbose
    then putStrLn $ "Processing (verbose): " ++ input
    else putStrLn $ "Processing: " ++ input
  -- TODO: implement logic
  putStrLn "Done!"
`,
      needsLlm: true,
    });
  } else if (cfg.type === "library") {
    files.push({
      path: "app/Main.hs",
      content: `module Main (main) where

import ${mod} (greeting)

main :: IO ()
main = putStrLn greeting
`,
      needsLlm: false,
    });

    files.push({
      path: `src/${mod}.hs`,
      content: `module ${mod}
  ( greeting
  , process
  ) where

-- | Library greeting
greeting :: String
greeting = "${mod} library loaded"

-- | Process input data
process :: String -> Either String String
process [] = Left "Empty input"
process input = Right $ "Processed: " ++ input
`,
      needsLlm: true,
    });

    files.push({
      path: "src/Lib.hs",
      content: `module Lib (version) where

version :: String
version = "0.1.0.0"
`,
      needsLlm: false,
    });
  } else if (cfg.type === "web") {
    files.push({
      path: "app/Main.hs",
      content: `{-# LANGUAGE OverloadedStrings #-}

module Main (main) where

import Web.Scotty
import Data.Aeson (object, (.=))

main :: IO ()
main = scotty 10080 $ do
  get "/health" $ do
    json $ object ["status" .= ("ok" :: String)]

  get "/" $ do
    html "<h1>Welcome to ${cfg.name}</h1>"

  -- TODO: add ${cfg.framework ?? "web"} routes
`,
      needsLlm: true,
    });

    files.push({
      path: "src/Lib.hs",
      content: `module Lib (appName) where

appName :: String
appName = "${cfg.name}"
`,
      needsLlm: false,
    });
  } else {
    // script
    files.push({
      path: "app/Main.hs",
      content: `module Main (main) where

import Lib (run)

main :: IO ()
main = Lib.run
`,
      needsLlm: false,
    });

    files.push({
      path: "src/Lib.hs",
      content: `module Lib (run) where

run :: IO ()
run = do
  putStrLn "Hello from ${cfg.name}!"
  -- TODO: implement logic
`,
      needsLlm: true,
    });
  }

  // Tests
  files.push({
    path: "test/Spec.hs",
    content: `import Test.Hspec

main :: IO ()
main = hspec $ do
  describe "${cfg.name}" $ do
    it "basic test" $ do
      True \`shouldBe\` True

    -- TODO: add tests
`,
    needsLlm: true,
  });

  // Extras
  files.push({
    path: ".gitignore",
    content: `.stack-work/
dist-newstyle/
*.hi
*.o
*.cabal
*.hp
*.prof
.env
result
`,
    needsLlm: false,
  });

  files.push({
    path: ".github/workflows/ci.yml",
    content: `name: CI
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: haskell-actions/setup@v2
        with:
          enable-stack: true
          stack-version: "latest"
      - run: stack build --test --no-run-tests
      - run: stack test
`,
    needsLlm: false,
  });

  files.push({
    path: "README.md",
    content: `# ${cfg.name}

Haskell ${cfg.type}${cfg.framework ? " (" + cfg.framework + ")" : ""}. Built with KCode.

\`\`\`bash
stack build
stack exec ${cfg.name}-exe
stack test
\`\`\`

*Astrolexis.space --- Kulvex Code*
`,
    needsLlm: false,
  });

  const projectPath = join(cwd, cfg.name);
  for (const f of files) {
    const p = join(projectPath, f.path);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, f.content);
  }

  const m = files.filter((f) => !f.needsLlm).length;
  return {
    config: cfg,
    files,
    projectPath,
    prompt: `Implement Haskell ${cfg.type}${cfg.framework ? " (" + cfg.framework + ")" : ""}. ${m} files machine. USER: "${userRequest}"`,
  };
}

function cap(s: string): string {
  return s
    .split(/[-_]/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join("");
}
