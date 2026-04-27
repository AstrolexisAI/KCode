// KCode - CI/CD Pipeline Engine
// Creates: GitHub Actions, GitLab CI, Jenkinsfile from description

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type CicdPlatform = "github" | "gitlab" | "jenkins" | "bitbucket";
export type CicdProjectType =
  | "node"
  | "python"
  | "go"
  | "rust"
  | "java"
  | "dotnet"
  | "docker"
  | "terraform"
  | "generic";

interface CicdConfig {
  name: string;
  platform: CicdPlatform;
  projectType: CicdProjectType;
  hasTest: boolean;
  hasLint: boolean;
  hasDeploy: boolean;
  hasDocker: boolean;
  hasMatrix: boolean;
  deployTarget?: string;
}

function detectCicdProject(msg: string): CicdConfig {
  const lower = msg.toLowerCase();
  let platform: CicdPlatform = "github";
  let projectType: CicdProjectType = "node";

  if (/\b(?:gitlab)\b/i.test(lower)) platform = "gitlab";
  else if (/\b(?:jenkins)\b/i.test(lower)) platform = "jenkins";
  else if (/\b(?:bitbucket)\b/i.test(lower)) platform = "bitbucket";

  if (/\b(?:python|pip|poetry|django|flask|fastapi)\b/i.test(lower)) projectType = "python";
  else if (/\b(?:go|golang)\b/i.test(lower)) projectType = "go";
  else if (/\b(?:rust|cargo)\b/i.test(lower)) projectType = "rust";
  else if (/\b(?:java|maven|gradle|spring)\b/i.test(lower)) projectType = "java";
  else if (/\b(?:dotnet|csharp|c#|nuget)\b/i.test(lower)) projectType = "dotnet";
  else if (/\b(?:docker|container)\b/i.test(lower)) projectType = "docker";
  else if (/\b(?:terraform|infra)\b/i.test(lower)) projectType = "terraform";

  let deployTarget: string | undefined;
  if (/\b(?:vercel)\b/i.test(lower)) deployTarget = "vercel";
  else if (/\b(?:aws|ec2|ecs|lambda|s3)\b/i.test(lower)) deployTarget = "aws";
  else if (/\b(?:gcp|google\s*cloud|cloud\s*run)\b/i.test(lower)) deployTarget = "gcp";
  else if (/\b(?:azure)\b/i.test(lower)) deployTarget = "azure";
  else if (/\b(?:fly|fly\.io)\b/i.test(lower)) deployTarget = "fly";
  else if (/\b(?:railway)\b/i.test(lower)) deployTarget = "railway";
  else if (/\b(?:heroku)\b/i.test(lower)) deployTarget = "heroku";

  const nameMatch = msg.match(/(?:called|named|nombre)\s+(\w[\w-]*)/i);
  const name = nameMatch?.[1] ?? "myproject";

  return {
    name,
    platform,
    projectType,
    hasTest: !/\bno.?test\b/i.test(lower),
    hasLint: !/\bno.?lint\b/i.test(lower),
    hasDeploy: !!deployTarget || /\b(?:deploy|cd|release|publish)\b/i.test(lower),
    hasDocker: /\b(?:docker|container|image|registry|ecr|gcr|ghcr)\b/i.test(lower),
    hasMatrix: /\b(?:matrix|multi.?version|multi.?os)\b/i.test(lower),
    deployTarget,
  };
}

interface GenFile {
  path: string;
  content: string;
  needsLlm: boolean;
}
export interface CicdProjectResult {
  config: CicdConfig;
  files: GenFile[];
  projectPath: string;
  prompt: string;
}

function buildSteps(cfg: CicdConfig): { setup: string; test: string; lint: string; build: string } {
  switch (cfg.projectType) {
    case "node":
      return {
        setup:
          "uses: actions/setup-node@v4\n        with: { node-version: 22 }\n      - run: npm ci",
        test: "npm test",
        lint: "npm run lint",
        build: "npm run build",
      };
    case "python":
      return {
        setup:
          "uses: actions/setup-python@v5\n        with: { python-version: '3.13' }\n      - run: pip install -e '.[dev]'",
        test: "pytest",
        lint: "ruff check .",
        build: "python -m build",
      };
    case "go":
      return {
        setup: "uses: actions/setup-go@v5\n        with: { go-version: '1.23' }",
        test: "go test ./...",
        lint: "golangci-lint run",
        build: "go build ./...",
      };
    case "rust":
      return {
        setup: "uses: dtolnay/rust-toolchain@stable\n      - uses: Swatinem/rust-cache@v2",
        test: "cargo test",
        lint: "cargo clippy -- -D warnings",
        build: "cargo build --release",
      };
    case "java":
      return {
        setup:
          "uses: actions/setup-java@v4\n        with: { distribution: temurin, java-version: 21 }",
        test: "./gradlew test",
        lint: "./gradlew check",
        build: "./gradlew build",
      };
    case "dotnet":
      return {
        setup: "uses: actions/setup-dotnet@v4\n        with: { dotnet-version: '9.0' }",
        test: "dotnet test",
        lint: "dotnet format --verify-no-changes",
        build: "dotnet build -c Release",
      };
    case "terraform":
      return {
        setup: "uses: hashicorp/setup-terraform@v3",
        test: "terraform validate",
        lint: "terraform fmt -check",
        build: "terraform plan",
      };
    case "docker":
      return {
        setup: "uses: docker/setup-buildx-action@v3",
        test: "docker compose run --rm app test",
        lint: "hadolint Dockerfile",
        build: "docker build -t ${{ github.repository }}:${{ github.sha }} .",
      };
    default:
      return {
        setup: "run: echo 'Setup'",
        test: "echo 'Tests'",
        lint: "echo 'Lint'",
        build: "echo 'Build'",
      };
  }
}

export function createCicdProject(userRequest: string, cwd: string): CicdProjectResult {
  const cfg = detectCicdProject(userRequest);
  const files: GenFile[] = [];
  const steps = buildSteps(cfg);

  if (cfg.platform === "github") {
    // CI workflow
    let ciYml = `name: CI\n\non:\n  push:\n    branches: [main, master]\n  pull_request:\n    branches: [main, master]\n\njobs:\n  ci:\n    runs-on: ubuntu-latest\n${cfg.hasMatrix ? `    strategy:\n      matrix:\n        ${cfg.projectType === "node" ? "node-version: [20, 22]" : cfg.projectType === "python" ? "python-version: ['3.12', '3.13']" : "os: [ubuntu-latest, macos-latest]"}\n` : ""}\n    steps:\n      - uses: actions/checkout@v4\n      - ${steps.setup}\n`;
    if (cfg.hasLint) ciYml += `      - name: Lint\n        run: ${steps.lint}\n`;
    if (cfg.hasTest) ciYml += `      - name: Test\n        run: ${steps.test}\n`;
    ciYml += `      - name: Build\n        run: ${steps.build}\n`;

    files.push({ path: ".github/workflows/ci.yml", content: ciYml, needsLlm: false });

    // Deploy workflow
    if (cfg.hasDeploy) {
      let deployYml = `name: Deploy\n\non:\n  push:\n    branches: [main, master]\n\njobs:\n  deploy:\n    runs-on: ubuntu-latest\n    needs: []\n    steps:\n      - uses: actions/checkout@v4\n      - ${steps.setup}\n      - name: Build\n        run: ${steps.build}\n`;

      if (cfg.hasDocker) {
        deployYml += `      - uses: docker/login-action@v3\n        with:\n          registry: ghcr.io\n          username: \${{ github.actor }}\n          password: \${{ secrets.GITHUB_TOKEN }}\n      - uses: docker/build-push-action@v6\n        with:\n          push: true\n          tags: ghcr.io/\${{ github.repository }}:\${{ github.sha }}\n`;
      }

      if (cfg.deployTarget === "vercel") {
        deployYml += `      - uses: amondnet/vercel-action@v25\n        with:\n          vercel-token: \${{ secrets.VERCEL_TOKEN }}\n          vercel-org-id: \${{ secrets.VERCEL_ORG_ID }}\n          vercel-project-id: \${{ secrets.VERCEL_PROJECT_ID }}\n          vercel-args: --prod\n`;
      } else if (cfg.deployTarget === "fly") {
        deployYml += `      - uses: superfly/flyctl-actions/setup-flyctl@master\n      - run: flyctl deploy --remote-only\n        env:\n          FLY_API_TOKEN: \${{ secrets.FLY_API_TOKEN }}\n`;
      } else {
        deployYml += `      # TODO: add deployment step for ${cfg.deployTarget ?? "your platform"}\n`;
      }

      files.push({ path: ".github/workflows/deploy.yml", content: deployYml, needsLlm: true });
    }

    // Dependabot
    files.push({
      path: ".github/dependabot.yml",
      content: `version: 2\nupdates:\n  - package-ecosystem: "${cfg.projectType === "node" ? "npm" : cfg.projectType === "python" ? "pip" : cfg.projectType === "go" ? "gomod" : cfg.projectType === "rust" ? "cargo" : "github-actions"}"\n    directory: "/"\n    schedule:\n      interval: weekly\n  - package-ecosystem: github-actions\n    directory: "/"\n    schedule:\n      interval: weekly\n`,
      needsLlm: false,
    });
  } else if (cfg.platform === "gitlab") {
    let gitlabCi = `stages:\n  - lint\n  - test\n  - build\n${cfg.hasDeploy ? "  - deploy\n" : ""}\n`;
    if (cfg.hasLint) gitlabCi += `lint:\n  stage: lint\n  script:\n    - ${steps.lint}\n\n`;
    if (cfg.hasTest) gitlabCi += `test:\n  stage: test\n  script:\n    - ${steps.test}\n\n`;
    gitlabCi += `build:\n  stage: build\n  script:\n    - ${steps.build}\n  artifacts:\n    paths:\n      - dist/\n\n`;
    if (cfg.hasDeploy)
      gitlabCi += `deploy:\n  stage: deploy\n  script:\n    - echo "TODO: deploy"\n  only:\n    - main\n  when: manual\n`;

    files.push({ path: ".gitlab-ci.yml", content: gitlabCi, needsLlm: cfg.hasDeploy });
  } else if (cfg.platform === "jenkins") {
    let jenkinsfile = `pipeline {\n  agent any\n\n  stages {\n`;
    if (cfg.hasLint)
      jenkinsfile += `    stage('Lint') {\n      steps {\n        sh '${steps.lint}'\n      }\n    }\n`;
    if (cfg.hasTest)
      jenkinsfile += `    stage('Test') {\n      steps {\n        sh '${steps.test}'\n      }\n    }\n`;
    jenkinsfile += `    stage('Build') {\n      steps {\n        sh '${steps.build}'\n      }\n    }\n`;
    if (cfg.hasDeploy)
      jenkinsfile += `    stage('Deploy') {\n      when { branch 'main' }\n      steps {\n        sh 'echo TODO: deploy'\n      }\n    }\n`;
    jenkinsfile += `  }\n\n  post {\n    always {\n      cleanWs()\n    }\n  }\n}\n`;

    files.push({ path: "Jenkinsfile", content: jenkinsfile, needsLlm: cfg.hasDeploy });
  }

  // Extras
  files.push({
    path: "README.md",
    content: `# ${cfg.name} CI/CD\n\nPipeline for ${cfg.projectType} (${cfg.platform}). Built with KCode.\n\n## Pipeline\n${cfg.hasLint ? "1. Lint\n" : ""}${cfg.hasTest ? "2. Test\n" : ""}3. Build\n${cfg.hasDeploy ? `4. Deploy → ${cfg.deployTarget ?? "TBD"}\n` : ""}\n*Astrolexis.space — Kulvex Code*\n`,
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
    prompt: `CI/CD pipeline (${cfg.platform}) for ${cfg.projectType}. ${m} files machine. USER: "${userRequest}"`,
  };
}
