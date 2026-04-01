# Homebrew formula for KCode (Kulvex Code)
# AI-powered coding assistant for the terminal by Astrolexis
#
# Install: brew install astrolexis/tap/kcode
# Update:  brew upgrade kcode
#
# This formula downloads pre-compiled binaries (no build from source).
# The binary includes an embedded Bun runtime (~99 MB).

class Kcode < Formula
  desc "AI-powered coding assistant for the terminal by Astrolexis"
  homepage "https://kulvex.ai"
  license "AGPL-3.0-only"
  version "1.8.0"

  # Pre-compiled binaries per platform
  on_macos do
    if Hardware::CPU.arm?
      url "https://github.com/AstrolexisAI/KCode/releases/download/v#{version}/kcode-#{version}-macos-arm64.tar.gz"
      sha256 "8f7924a8d7d407921e3901ba84182ad192e311a03d03b3d9f9036ca2504d32df"
    else
      url "https://github.com/AstrolexisAI/KCode/releases/download/v#{version}/kcode-#{version}-macos-x64.tar.gz"
      sha256 "dbeb4071fddec057fd0815bbc3aabaa966573be72cc65d63662a0ab8dc3afaf1"
    end
  end

  on_linux do
    if Hardware::CPU.arm?
      url "https://github.com/AstrolexisAI/KCode/releases/download/v#{version}/kcode-#{version}-linux-arm64.tar.gz"
      sha256 "a2a7f1ba3ecddb568cd71af089e1a6fe199e061bf43739db80ca9643e2da4802"
    else
      url "https://github.com/AstrolexisAI/KCode/releases/download/v#{version}/kcode-#{version}-linux-x64.tar.gz"
      sha256 "914657f4b51022b7d6341cf8901594adbdd7fe5969d40f719b2d1b4027e23ae8"
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
    # Create config directory
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
