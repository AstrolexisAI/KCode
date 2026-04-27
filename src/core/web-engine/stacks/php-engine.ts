// KCode - PHP Project Engine

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type PhpProjectType = "api" | "web" | "cli" | "library" | "wordpress" | "custom";

interface PhpConfig {
  name: string;
  type: PhpProjectType;
  framework?: string;
  deps: Record<string, string>;
  devDeps: Record<string, string>;
}

function detectPhpProject(msg: string): PhpConfig {
  const lower = msg.toLowerCase();
  let type: PhpProjectType = "api";
  let framework: string | undefined;
  const deps: Record<string, string> = {};
  const devDeps: Record<string, string> = { "phpunit/phpunit": "^11.0" };

  if (/\b(?:laravel)\b/i.test(lower)) {
    type = "web";
    framework = "laravel";
    deps["laravel/framework"] = "^11.0";
  } else if (/\b(?:symfony)\b/i.test(lower)) {
    type = "api";
    framework = "symfony";
    deps["symfony/framework-bundle"] = "^7.0";
    deps["symfony/runtime"] = "^7.0";
  } else if (/\b(?:slim|api|rest|server)\b/i.test(lower)) {
    type = "api";
    framework = "slim";
    deps["slim/slim"] = "^4.0";
    deps["slim/psr7"] = "^1.7";
    deps["php-di/slim-bridge"] = "^3.4";
    deps["monolog/monolog"] = "^3.0";
  } else if (/\b(?:web|site|app|page)\b/i.test(lower)) {
    type = "web";
    framework = "laravel";
    deps["laravel/framework"] = "^11.0";
  } else if (/\b(?:cli|console|command|script)\b/i.test(lower)) {
    type = "cli";
    deps["symfony/console"] = "^7.0";
  } else if (/\b(?:lib|library|package|composer)\b/i.test(lower)) {
    type = "library";
  } else if (/\b(?:wordpress|wp|plugin)\b/i.test(lower)) {
    type = "wordpress";
  } else {
    framework = "slim";
    deps["slim/slim"] = "^4.0";
    deps["slim/psr7"] = "^1.7";
    deps["monolog/monolog"] = "^3.0";
  }

  if (/\b(?:eloquent|database|db|postgres|mysql)\b/i.test(lower))
    deps["illuminate/database"] = "^11.0";
  if (/\b(?:guzzle|http|client)\b/i.test(lower)) deps["guzzlehttp/guzzle"] = "^7.0";
  if (/\b(?:twig|blade|template)\b/i.test(lower)) deps["twig/twig"] = "^3.0";
  if (/\b(?:monolog|log)\b/i.test(lower)) deps["monolog/monolog"] = "^3.0";

  const nameMatch = msg.match(/(?:called|named|nombre)\s+(\w[\w-]*)/i);
  const name = nameMatch?.[1] ?? (type === "library" ? "mylib" : "myapp");

  return { name, type, framework, deps, devDeps };
}

interface GenFile {
  path: string;
  content: string;
  needsLlm: boolean;
}
export interface PhpProjectResult {
  config: PhpConfig;
  files: GenFile[];
  projectPath: string;
  prompt: string;
}

export function createPhpProject(userRequest: string, cwd: string): PhpProjectResult {
  const cfg = detectPhpProject(userRequest);
  const files: GenFile[] = [];

  // composer.json
  files.push({
    path: "composer.json",
    content: JSON.stringify(
      {
        name: `vendor/${cfg.name}`,
        type: cfg.type === "library" ? "library" : "project",
        autoload: { "psr-4": { [`${cap(cfg.name)}\\`]: "src/" } },
        "autoload-dev": { "psr-4": { [`${cap(cfg.name)}\\Tests\\`]: "tests/" } },
        require: { php: ">=8.3", ...cfg.deps },
        "require-dev": cfg.devDeps,
        scripts: {
          test: "phpunit",
          serve: cfg.type === "api" ? "php -S localhost:10080 -t public" : "php -S localhost:10080",
        },
      },
      null,
      4,
    ),
    needsLlm: false,
  });

  // Main code per type
  if (cfg.type === "api" && cfg.framework === "slim") {
    files.push({
      path: "public/index.php",
      content: `<?php

declare(strict_types=1);

require __DIR__ . '/../vendor/autoload.php';

use Slim\\Factory\\AppFactory;
use Psr\\Http\\Message\\ResponseInterface as Response;
use Psr\\Http\\Message\\ServerRequestInterface as Request;
use Psr\\Http\\Server\\RequestHandlerInterface as RequestHandler;
use Slim\\Exception\\HttpNotFoundException;
use ${cap(cfg.name)}\\ItemRepository;
use Monolog\\Logger;
use Monolog\\Handler\\StreamHandler;

$logger = new Logger('${cfg.name}');
$logger->pushHandler(new StreamHandler(__DIR__ . '/../logs/app.log', Logger::DEBUG));
$logger->pushHandler(new StreamHandler('php://stderr', Logger::INFO));

$app = AppFactory::create();

// JSON error handling middleware
$errorMiddleware = $app->addErrorMiddleware(true, true, true);
$errorMiddleware->setDefaultErrorHandler(function (
    Request $request,
    \\Throwable $exception,
    bool $displayErrorDetails,
    bool $logErrors,
    bool $logErrorDetails
) use ($app, $logger) {
    $logger->error($exception->getMessage(), ['trace' => $exception->getTraceAsString()]);
    $statusCode = $exception instanceof \\Slim\\Exception\\HttpException ? $exception->getCode() : 500;
    $response = $app->getResponseFactory()->createResponse($statusCode);
    $response->getBody()->write(json_encode([
        'error' => true,
        'message' => $exception->getMessage(),
    ]));
    return $response->withHeader('Content-Type', 'application/json');
});

// JSON Content-Type middleware
$app->add(function (Request $request, RequestHandler $handler) {
    $response = $handler->handle($request);
    return $response->withHeader('Content-Type', 'application/json');
});

$repo = new ItemRepository();

// Health check
$app->get('/health', function (Request $request, Response $response) {
    $response->getBody()->write(json_encode(['status' => 'ok']));
    return $response;
});

// List all items
$app->get('/api/items', function (Request $request, Response $response) use ($repo, $logger) {
    $logger->info('Listing all items');
    $response->getBody()->write(json_encode($repo->findAll()));
    return $response;
});

// Get single item
$app->get('/api/items/{id}', function (Request $request, Response $response, array $args) use ($repo, $logger) {
    $id = (int) $args['id'];
    $item = $repo->findById($id);
    if ($item === null) {
        $logger->info('Item not found', ['id' => $id]);
        $response->getBody()->write(json_encode(['error' => true, 'message' => 'Item not found']));
        return $response->withStatus(404);
    }
    $response->getBody()->write(json_encode($item));
    return $response;
});

// Create item
$app->post('/api/items', function (Request $request, Response $response) use ($repo, $logger) {
    $body = $request->getParsedBody();
    $errors = [];
    if (empty($body['name']) || !is_string($body['name'])) {
        $errors[] = 'name is required and must be a string';
    }
    if (isset($body['description']) && !is_string($body['description'])) {
        $errors[] = 'description must be a string';
    }
    if (!empty($errors)) {
        $logger->info('Validation failed on create', ['errors' => $errors]);
        $response->getBody()->write(json_encode(['error' => true, 'errors' => $errors]));
        return $response->withStatus(422);
    }
    $item = $repo->create($body['name'], $body['description'] ?? '');
    $logger->info('Item created', ['id' => $item['id']]);
    $response->getBody()->write(json_encode($item));
    return $response->withStatus(201);
});

// Update item
$app->put('/api/items/{id}', function (Request $request, Response $response, array $args) use ($repo, $logger) {
    $id = (int) $args['id'];
    $body = $request->getParsedBody();
    $errors = [];
    if (isset($body['name']) && !is_string($body['name'])) {
        $errors[] = 'name must be a string';
    }
    if (isset($body['description']) && !is_string($body['description'])) {
        $errors[] = 'description must be a string';
    }
    if (!empty($errors)) {
        $response->getBody()->write(json_encode(['error' => true, 'errors' => $errors]));
        return $response->withStatus(422);
    }
    $item = $repo->update($id, $body['name'] ?? null, $body['description'] ?? null);
    if ($item === null) {
        $logger->info('Item not found for update', ['id' => $id]);
        $response->getBody()->write(json_encode(['error' => true, 'message' => 'Item not found']));
        return $response->withStatus(404);
    }
    $logger->info('Item updated', ['id' => $id]);
    $response->getBody()->write(json_encode($item));
    return $response;
});

// Delete item
$app->delete('/api/items/{id}', function (Request $request, Response $response, array $args) use ($repo, $logger) {
    $id = (int) $args['id'];
    $deleted = $repo->delete($id);
    if (!$deleted) {
        $logger->info('Item not found for delete', ['id' => $id]);
        $response->getBody()->write(json_encode(['error' => true, 'message' => 'Item not found']));
        return $response->withStatus(404);
    }
    $logger->info('Item deleted', ['id' => $id]);
    $response->getBody()->write(json_encode(['deleted' => true]));
    return $response;
});

$app->addBodyParsingMiddleware();
$app->run();
`,
      needsLlm: false,
    });

    files.push({
      path: `src/ItemRepository.php`,
      content: `<?php

declare(strict_types=1);

namespace ${cap(cfg.name)};

class ItemRepository
{
    /** @var array<int, array{id: int, name: string, description: string, createdAt: string}> */
    private array $items = [];
    private int $nextId = 1;

    /** @return array<int, array{id: int, name: string, description: string, createdAt: string}> */
    public function findAll(): array
    {
        return array_values($this->items);
    }

    /** @return array{id: int, name: string, description: string, createdAt: string}|null */
    public function findById(int $id): ?array
    {
        return $this->items[$id] ?? null;
    }

    /** @return array{id: int, name: string, description: string, createdAt: string} */
    public function create(string $name, string $description = ''): array
    {
        $item = [
            'id' => $this->nextId,
            'name' => $name,
            'description' => $description,
            'createdAt' => date('c'),
        ];
        $this->items[$this->nextId] = $item;
        $this->nextId++;
        return $item;
    }

    /** @return array{id: int, name: string, description: string, createdAt: string}|null */
    public function update(int $id, ?string $name, ?string $description): ?array
    {
        if (!isset($this->items[$id])) {
            return null;
        }
        if ($name !== null) {
            $this->items[$id]['name'] = $name;
        }
        if ($description !== null) {
            $this->items[$id]['description'] = $description;
        }
        return $this->items[$id];
    }

    public function delete(int $id): bool
    {
        if (!isset($this->items[$id])) {
            return false;
        }
        unset($this->items[$id]);
        return true;
    }
}
`,
      needsLlm: false,
    });
  } else if (cfg.type === "cli") {
    files.push({
      path: "bin/console",
      content: `#!/usr/bin/env php
<?php

require __DIR__ . '/../vendor/autoload.php';

use Symfony\\Component\\Console\\Application;
use ${cap(cfg.name)}\\Command\\MainCommand;

$app = new Application('${cfg.name}', '0.1.0');
$app->add(new MainCommand());
$app->run();
`,
      needsLlm: false,
    });

    files.push({
      path: `src/Command/MainCommand.php`,
      content: `<?php

namespace ${cap(cfg.name)}\\Command;

use Symfony\\Component\\Console\\Command\\Command;
use Symfony\\Component\\Console\\Input\\InputArgument;
use Symfony\\Component\\Console\\Input\\InputInterface;
use Symfony\\Component\\Console\\Input\\InputOption;
use Symfony\\Component\\Console\\Output\\OutputInterface;

class MainCommand extends Command
{
    protected function configure(): void
    {
        $this->setName('run')
             ->setDescription('Run the main command')
             ->addArgument('input', InputArgument::REQUIRED, 'Input file')
             ->addOption('output', 'o', InputOption::VALUE_OPTIONAL, 'Output path', 'output.txt')
             ->addOption('verbose', 'v', InputOption::VALUE_NONE, 'Verbose output');
    }

    protected function execute(InputInterface $input, OutputInterface $output): int
    {
        $file = $input->getArgument('input');
        $output->writeln("Processing: {$file}");

        // TODO: implement logic

        $output->writeln('<info>Done!</info>');
        return Command::SUCCESS;
    }
}
`,
      needsLlm: true,
    });
  } else if (cfg.type === "library") {
    files.push({
      path: `src/${cap(cfg.name)}.php`,
      content: `<?php

namespace ${cap(cfg.name)};

class ${cap(cfg.name)}
{
    private bool $initialized = false;

    public function initialize(): void
    {
        // TODO: setup
        $this->initialized = true;
    }

    public function process(mixed $data): mixed
    {
        if (!$this->initialized) {
            throw new \\RuntimeException('Not initialized. Call initialize() first.');
        }
        // TODO: main logic
        return $data;
    }
}
`,
      needsLlm: true,
    });
  } else if (cfg.type === "wordpress") {
    files.push({
      path: `${cfg.name}.php`,
      content: `<?php
/**
 * Plugin Name: ${cap(cfg.name)}
 * Description: ${cfg.name} WordPress plugin
 * Version: 0.1.0
 * Author: KCode
 */

defined('ABSPATH') || exit;

// TODO: implement plugin
add_action('init', function () {
    // Register custom post types, taxonomies, etc.
});

add_action('admin_menu', function () {
    add_menu_page(
        '${cap(cfg.name)}',
        '${cap(cfg.name)}',
        'manage_options',
        '${cfg.name}',
        function () { echo '<div class="wrap"><h1>${cap(cfg.name)}</h1><p>Settings page.</p></div>'; },
        'dashicons-admin-generic',
    );
});
`,
      needsLlm: true,
    });
  } else {
    // Default web with framework
    files.push({
      path: "public/index.php",
      content: `<?php
require __DIR__ . '/../vendor/autoload.php';

// TODO: implement application entry point
echo json_encode(['status' => 'ok', 'app' => '${cfg.name}']);
`,
      needsLlm: true,
    });
  }

  // Test
  if (cfg.type === "api" && cfg.framework === "slim") {
    files.push({
      path: `tests/${cap(cfg.name)}Test.php`,
      content: `<?php

namespace ${cap(cfg.name)}\\Tests;

use PHPUnit\\Framework\\TestCase;
use ${cap(cfg.name)}\\ItemRepository;

class ${cap(cfg.name)}Test extends TestCase
{
    private ItemRepository $repo;

    protected function setUp(): void
    {
        $this->repo = new ItemRepository();
    }

    public function testFindAllEmpty(): void
    {
        $this->assertSame([], $this->repo->findAll());
    }

    public function testCreateItem(): void
    {
        $item = $this->repo->create('Widget', 'A fine widget');
        $this->assertSame(1, $item['id']);
        $this->assertSame('Widget', $item['name']);
        $this->assertSame('A fine widget', $item['description']);
        $this->assertArrayHasKey('createdAt', $item);
    }

    public function testFindById(): void
    {
        $created = $this->repo->create('Gadget');
        $found = $this->repo->findById($created['id']);
        $this->assertNotNull($found);
        $this->assertSame('Gadget', $found['name']);
    }

    public function testFindByIdNotFound(): void
    {
        $this->assertNull($this->repo->findById(999));
    }

    public function testUpdateItem(): void
    {
        $created = $this->repo->create('Old Name', 'Old desc');
        $updated = $this->repo->update($created['id'], 'New Name', null);
        $this->assertNotNull($updated);
        $this->assertSame('New Name', $updated['name']);
        $this->assertSame('Old desc', $updated['description']);
    }

    public function testUpdateNotFound(): void
    {
        $this->assertNull($this->repo->update(999, 'x', null));
    }

    public function testDeleteItem(): void
    {
        $created = $this->repo->create('ToDelete');
        $this->assertTrue($this->repo->delete($created['id']));
        $this->assertNull($this->repo->findById($created['id']));
    }

    public function testDeleteNotFound(): void
    {
        $this->assertFalse($this->repo->delete(999));
    }

    public function testFindAllAfterMultipleCreates(): void
    {
        $this->repo->create('One');
        $this->repo->create('Two');
        $this->repo->create('Three');
        $this->assertCount(3, $this->repo->findAll());
    }
}
`,
      needsLlm: false,
    });
  } else {
    files.push({
      path: `tests/${cap(cfg.name)}Test.php`,
      content: `<?php

namespace ${cap(cfg.name)}\\Tests;

use PHPUnit\\Framework\\TestCase;

class ${cap(cfg.name)}Test extends TestCase
{
    public function testBasic(): void
    {
        $this->assertTrue(true);
    }

    // TODO: add tests
}
`,
      needsLlm: true,
    });
  }

  // phpunit.xml
  files.push({
    path: "phpunit.xml",
    content: `<?xml version="1.0" encoding="UTF-8"?>
<phpunit bootstrap="vendor/autoload.php" colors="true">
    <testsuites>
        <testsuite name="default">
            <directory>tests</directory>
        </testsuite>
    </testsuites>
</phpunit>
`,
    needsLlm: false,
  });

  // Extras
  files.push({
    path: ".gitignore",
    content: "vendor/\n.env\n*.cache\n.phpunit.result.cache\n",
    needsLlm: false,
  });
  files.push({
    path: "Dockerfile",
    content: `FROM php:8.3-fpm-alpine
RUN apk add --no-cache curl && curl -sS https://getcomposer.org/installer | php -- --install-dir=/usr/local/bin --filename=composer
WORKDIR /app
COPY composer.* ./
RUN composer install --no-dev --optimize-autoloader
COPY . .
EXPOSE 10080
CMD ["php", "-S", "0.0.0.0:10080", "-t", "public"]
`,
    needsLlm: false,
  });
  files.push({
    path: ".github/workflows/ci.yml",
    content: `name: CI\non: [push, pull_request]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - uses: shivammathur/setup-php@v2\n        with: { php-version: "8.3" }\n      - run: composer install\n      - run: composer test\n`,
    needsLlm: false,
  });
  files.push({
    path: "README.md",
    content: `# ${cfg.name}\n\nPHP ${cfg.type}${cfg.framework ? " (" + cfg.framework + ")" : ""}. Built with KCode.\n\n\`\`\`bash\ncomposer install\ncomposer serve\ncomposer test\n\`\`\`\n\n*Astrolexis.space — Kulvex Code*\n`,
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
    prompt: `Implement PHP ${cfg.type}${cfg.framework ? " (" + cfg.framework + ")" : ""}. ${m} files machine. USER: "${userRequest}"`,
  };
}

function cap(s: string): string {
  return s
    .split(/[-_]/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join("");
}
