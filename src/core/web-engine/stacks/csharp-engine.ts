// KCode - C#/.NET Project Engine

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type CSharpProjectType = "api" | "blazor" | "cli" | "library" | "worker" | "grpc" | "maui" | "game" | "custom";

interface CSharpConfig { name: string; type: CSharpProjectType; framework?: string; deps: string[]; targetFramework: string; }

function detectCSharpProject(msg: string): CSharpConfig {
  const lower = msg.toLowerCase();
  let type: CSharpProjectType = "api";
  let framework: string | undefined;
  const deps: string[] = [];
  const targetFramework = "net9.0";

  if (/\b(?:blazor|wasm|webassembly|spa)\b/i.test(lower)) { type = "blazor"; }
  else if (/\b(?:api|server|rest|web\s*api|minimal\s*api|asp\.?net)\b/i.test(lower)) {
    type = "api";
    if (/\b(?:minimal)\b/i.test(lower)) framework = "minimal";
    else framework = "controllers";
  }
  else if (/\b(?:cli|console|command|tool)\b/i.test(lower)) { type = "cli"; deps.push("System.CommandLine"); }
  else if (/\b(?:lib|library|nuget|package)\b/i.test(lower)) { type = "library"; }
  else if (/\b(?:worker|background|service|queue|hosted)\b/i.test(lower)) { type = "worker"; }
  else if (/\b(?:grpc|protobuf)\b/i.test(lower)) { type = "grpc"; }
  else if (/\b(?:maui|mobile|xamarin|ios|android|cross.?platform)\b/i.test(lower)) { type = "maui"; }
  else if (/\b(?:game|unity|monogame|godot)\b/i.test(lower)) { type = "game"; framework = "monogame"; }

  if (/\b(?:ef|entity\s*framework|database|db|postgres|sql)\b/i.test(lower)) deps.push("Microsoft.EntityFrameworkCore", "Microsoft.EntityFrameworkCore.Sqlite");
  if (/\b(?:swagger|openapi)\b/i.test(lower)) deps.push("Swashbuckle.AspNetCore");
  if (/\b(?:auth|identity|jwt)\b/i.test(lower)) deps.push("Microsoft.AspNetCore.Authentication.JwtBearer");
  if (/\b(?:redis|cache)\b/i.test(lower)) deps.push("StackExchange.Redis");
  if (/\b(?:serilog|log)\b/i.test(lower)) deps.push("Serilog.AspNetCore");
  if (/\b(?:mediator|mediatr|cqrs)\b/i.test(lower)) deps.push("MediatR");
  if (/\b(?:fluent|validation)\b/i.test(lower)) deps.push("FluentValidation");
  if (/\b(?:signalr|realtime|websocket)\b/i.test(lower)) deps.push("Microsoft.AspNetCore.SignalR");

  const nameMatch = msg.match(/(?:called|named|nombre)\s+(\w[\w-]*)/i);
  const name = nameMatch?.[1] ?? (type === "library" ? "MyLib" : "MyApp");

  return { name, type, framework, deps: [...new Set(deps)], targetFramework };
}

interface GenFile { path: string; content: string; needsLlm: boolean; }
export interface CSharpProjectResult { config: CSharpConfig; files: GenFile[]; projectPath: string; prompt: string; }

export function createCSharpProject(userRequest: string, cwd: string): CSharpProjectResult {
  const cfg = detectCSharpProject(userRequest);
  const files: GenFile[] = [];

  // .csproj
  const pkgRefs = cfg.deps.map(d => `    <PackageReference Include="${d}" Version="*" />`).join("\n");
  const sdkType = cfg.type === "blazor" ? "Microsoft.NET.Sdk.BlazorWebAssembly" : (["api", "grpc"].includes(cfg.type) ? "Microsoft.NET.Sdk.Web" : "Microsoft.NET.Sdk");

  files.push({ path: `${cfg.name}.csproj`, content: `<Project Sdk="${sdkType}">

  <PropertyGroup>
    <TargetFramework>${cfg.targetFramework}</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
${cfg.type === "cli" || cfg.type === "api" || cfg.type === "worker" || cfg.type === "blazor" ? "    <OutputType>Exe</OutputType>" : ""}
  </PropertyGroup>

${pkgRefs ? `  <ItemGroup>\n${pkgRefs}\n  </ItemGroup>` : ""}
</Project>
`, needsLlm: false });

  // Solution
  files.push({ path: `${cfg.name}.sln`, content: `Microsoft Visual Studio Solution File, Format Version 12.00
Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "${cfg.name}", "${cfg.name}.csproj", "{00000000-0000-0000-0000-000000000001}"
EndProject
`, needsLlm: false });

  // Main code per type
  if (cfg.type === "api") {
    if (cfg.framework === "minimal") {
      files.push({ path: "Program.cs", content: `var builder = WebApplication.CreateBuilder(args);
builder.Services.AddEndpointsApiExplorer();

var app = builder.Build();

app.MapGet("/health", () => Results.Ok(new { status = "ok" }));

// TODO: add routes
app.MapGet("/api/items", () => new[] { new { Id = 1, Name = "Sample" } });
app.MapPost("/api/items", (ItemRequest req) => Results.Created($"/api/items/1", req));

app.Run();

record ItemRequest(string Name, string Description);
`, needsLlm: true });
    } else {
      files.push({ path: "Program.cs", content: `var builder = WebApplication.CreateBuilder(args);
builder.Services.AddControllers();
builder.Services.AddEndpointsApiExplorer();

var app = builder.Build();
app.MapControllers();
app.Run();
`, needsLlm: false });

      files.push({ path: "Controllers/HealthController.cs", content: `using Microsoft.AspNetCore.Mvc;

namespace ${cfg.name}.Controllers;

[ApiController]
[Route("api/[controller]")]
public class HealthController : ControllerBase
{
    [HttpGet("/health")]
    public IActionResult Health() => Ok(new { status = "ok" });
}
`, needsLlm: false });

      files.push({ path: "Controllers/ItemsController.cs", content: `using Microsoft.AspNetCore.Mvc;

namespace ${cfg.name}.Controllers;

[ApiController]
[Route("api/[controller]")]
public class ItemsController : ControllerBase
{
    [HttpGet]
    public IActionResult List() => Ok(new[] { new { Id = 1, Name = "Sample" } });

    [HttpGet("{id}")]
    public IActionResult Get(int id) => Ok(new { Id = id, Name = "Sample" });

    [HttpPost]
    public IActionResult Create([FromBody] object body) => CreatedAtAction(nameof(Get), new { id = 1 }, body);

    [HttpDelete("{id}")]
    public IActionResult Delete(int id) => NoContent();

    // TODO: implement with real data
}
`, needsLlm: true });
    }

    files.push({ path: "Properties/launchSettings.json", content: JSON.stringify({
      profiles: { [cfg.name]: { commandName: "Project", launchBrowser: false, environmentVariables: { ASPNETCORE_ENVIRONMENT: "Development" }, applicationUrl: "http://localhost:10080" } }
    }, null, 2), needsLlm: false });

  } else if (cfg.type === "cli") {
    files.push({ path: "Program.cs", content: `using System.CommandLine;

var rootCommand = new RootCommand("${cfg.name} — CLI tool");

var inputArg = new Argument<string>("input", "Input file path");
var outputOpt = new Option<string>("--output", () => "output.txt", "Output file path");
var verboseOpt = new Option<bool>("--verbose", "Verbose output");

rootCommand.AddArgument(inputArg);
rootCommand.AddOption(outputOpt);
rootCommand.AddOption(verboseOpt);

rootCommand.SetHandler((input, output, verbose) =>
{
    if (verbose) Console.WriteLine($"Processing: {input}");

    // TODO: implement CLI logic

    Console.WriteLine("Done!");
}, inputArg, outputOpt, verboseOpt);

return await rootCommand.InvokeAsync(args);
`, needsLlm: true });

  } else if (cfg.type === "library") {
    files.push({ path: `${cfg.name}.cs`, content: `namespace ${cfg.name};

/// <summary>${cfg.name} — Main library class</summary>
public class ${cfg.name}Client
{
    private bool _initialized;

    public async Task InitializeAsync()
    {
        // TODO: setup
        _initialized = true;
        await Task.CompletedTask;
    }

    public async Task<T> ProcessAsync<T>(T data)
    {
        if (!_initialized) throw new InvalidOperationException("Not initialized. Call InitializeAsync() first.");
        // TODO: main logic
        return await Task.FromResult(data);
    }
}
`, needsLlm: true });

  } else if (cfg.type === "worker") {
    files.push({ path: "Program.cs", content: `var builder = Host.CreateApplicationBuilder(args);
builder.Services.AddHostedService<Worker>();
var host = builder.Build();
host.Run();
`, needsLlm: false });

    files.push({ path: "Worker.cs", content: `namespace ${cfg.name};

public class Worker : BackgroundService
{
    private readonly ILogger<Worker> _logger;

    public Worker(ILogger<Worker> logger) => _logger = logger;

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            _logger.LogInformation("Worker running at: {time}", DateTimeOffset.Now);

            // TODO: process jobs

            await Task.Delay(1000, stoppingToken);
        }
    }
}
`, needsLlm: true });

  } else if (cfg.type === "blazor") {
    files.push({ path: "Program.cs", content: `using Microsoft.AspNetCore.Components.Web;
using Microsoft.AspNetCore.Components.WebAssembly.Hosting;
using ${cfg.name};

var builder = WebAssemblyHostBuilder.CreateDefault(args);
builder.RootComponents.Add<App>("#app");
builder.RootComponents.Add<HeadOutlet>("head::after");
builder.Services.AddScoped(_ => new HttpClient { BaseAddress = new Uri(builder.HostEnvironment.BaseAddress) });

await builder.Build().RunAsync();
`, needsLlm: false });

    files.push({ path: "App.razor", content: `<Router AppAssembly="@typeof(App).Assembly">
    <Found Context="routeData">
        <RouteView RouteData="@routeData" DefaultLayout="@typeof(MainLayout)" />
    </Found>
    <NotFound>
        <PageTitle>Not found</PageTitle>
        <p>Sorry, nothing here.</p>
    </NotFound>
</Router>
`, needsLlm: false });

    files.push({ path: "Shared/MainLayout.razor", content: `@inherits LayoutComponentBase

<main class="container">
    @Body
</main>
`, needsLlm: false });

    files.push({ path: "Pages/Home.razor", content: `@page "/"

<PageTitle>${cfg.name}</PageTitle>

<h1>${cfg.name}</h1>
<p>Counter: @count</p>
<button @onclick="Increment">Click me</button>

@code {
    private int count = 0;
    private void Increment() => count++;

    // TODO: implement UI
}
`, needsLlm: true });

    files.push({ path: "wwwroot/index.html", content: `<!DOCTYPE html>
<html><head><meta charset="utf-8"/><title>${cfg.name}</title><base href="/"/></head>
<body><div id="app">Loading...</div><script src="_framework/blazor.webassembly.js"></script></body></html>
`, needsLlm: false });
  }

  // Tests
  files.push({ path: `Tests/${cfg.name}Tests.cs`, content: `namespace ${cfg.name}.Tests;

public class BasicTests
{
    [Fact]
    public void ShouldPass()
    {
        Assert.True(true);
    }

    // TODO: add tests
}
`, needsLlm: true });

  files.push({ path: `Tests/${cfg.name}.Tests.csproj`, content: `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>${cfg.targetFramework}</TargetFramework>
    <IsPackable>false</IsPackable>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Microsoft.NET.Test.Sdk" Version="*" />
    <PackageReference Include="xunit" Version="*" />
    <PackageReference Include="xunit.runner.visualstudio" Version="*" />
  </ItemGroup>
  <ItemGroup>
    <ProjectReference Include="..\\${cfg.name}.csproj" />
  </ItemGroup>
</Project>
`, needsLlm: false });

  // Extras
  files.push({ path: ".gitignore", content: "bin/\nobj/\n*.user\n*.suo\n.vs/\n.env\n", needsLlm: false });
  files.push({ path: "Dockerfile", content: `FROM mcr.microsoft.com/dotnet/sdk:9.0 AS build
WORKDIR /src
COPY *.csproj ./
RUN dotnet restore
COPY . .
RUN dotnet publish -c Release -o /app

FROM mcr.microsoft.com/dotnet/aspnet:9.0
WORKDIR /app
COPY --from=build /app .
EXPOSE 10080
ENTRYPOINT ["dotnet", "${cfg.name}.dll"]
`, needsLlm: false });
  files.push({ path: ".github/workflows/ci.yml", content: `name: CI\non: [push, pull_request]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - uses: actions/setup-dotnet@v4\n        with: { dotnet-version: "9.0" }\n      - run: dotnet build\n      - run: dotnet test\n`, needsLlm: false });
  files.push({ path: "README.md", content: `# ${cfg.name}\n\n.NET ${cfg.type}. Built with KCode.\n\n\`\`\`bash\ndotnet run\ndotnet test\n\`\`\`\n\n*Astrolexis.space — Kulvex Code*\n`, needsLlm: false });

  const projectPath = join(cwd, cfg.name);
  for (const f of files) { const p = join(projectPath, f.path); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, f.content); }

  const m = files.filter(f => !f.needsLlm).length;
  return { config: cfg, files, projectPath, prompt: `Implement C#/.NET ${cfg.type}${cfg.framework ? " (" + cfg.framework + ")" : ""}. ${m} files machine. USER: "${userRequest}"` };
}
