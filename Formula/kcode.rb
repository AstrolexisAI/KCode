# Homebrew formula for KCode (Kulvex Code)
# AI-powered coding assistant for the terminal by Astrolexis
#
# Install: brew install astrolexis/tap/kcode
# Update:  brew upgrade kcode
#
# This formula downloads pre-compiled binaries (no build from source).
# The binary includes an embedded Bun runtime (~99 MB).

class Kcode < Formula
  desc "Terminal-based AI coding assistant for local LLMs and cloud APIs"
  homepage "https://kulvex.ai"
  version "2.5.0"
  license "AGPL-3.0-only"

  on_macos do
    on_arm do
      url "https://github.com/AstrolexisAI/KCode/releases/download/v#{version}/kcode-#{version}-darwin-arm64.tar.gz"
      sha256 "PLACEHOLDER_SHA256"
    end
    on_intel do
      url "https://github.com/AstrolexisAI/KCode/releases/download/v#{version}/kcode-#{version}-darwin-x64.tar.gz"
      sha256 "PLACEHOLDER_SHA256"
    end
  end

  on_linux do
    on_arm do
      url "https://github.com/AstrolexisAI/KCode/releases/download/v#{version}/kcode-#{version}-linux-arm64.tar.gz"
      sha256 "PLACEHOLDER_SHA256"
    end
    on_intel do
      url "https://github.com/AstrolexisAI/KCode/releases/download/v#{version}/kcode-#{version}-linux-x64.tar.gz"
      sha256 "PLACEHOLDER_SHA256"
    end
  end

  def install
    bin.install "kcode"

    # Generate and install shell completions
    bash_completion.install Utils.safe_popen_read(bin/"kcode", "completions", "bash").strip => "kcode"
    zsh_completion.install Utils.safe_popen_read(bin/"kcode", "completions", "zsh").strip => "_kcode"
    fish_completion.install Utils.safe_popen_read(bin/"kcode", "completions", "fish").strip => "kcode.fish"
  end

  def post_install
    (Dir.home/".kcode").mkpath
  end

  def caveats
    <<~EOS
      KCode has been installed. Get started:

        kcode                    # Interactive mode
        kcode setup              # First-time setup wizard
        kcode "your prompt"      # Single prompt mode

      Configuration: ~/.kcode/settings.json
      Documentation: https://kulvex.ai/docs
    EOS
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/kcode --version")
  end
end
