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
  version "2.5.2"
  license "Apache-2.0"

  on_macos do
    on_arm do
      url "https://github.com/AstrolexisAI/KCode/releases/download/v#{version}/kcode-#{version}-macos-arm64"
      sha256 "ba381cb784adb24a3fc8078a3ebb1c0a3892a237570bbce34a42e22dc04a6f16"
    end
    on_intel do
      url "https://github.com/AstrolexisAI/KCode/releases/download/v#{version}/kcode-#{version}-macos-x64"
      sha256 "15cf322ce9f3912fb6d80c8b52e33757a91b9c89684c6216cb9c3000969d6201"
    end
  end

  on_linux do
    on_arm do
      url "https://github.com/AstrolexisAI/KCode/releases/download/v#{version}/kcode-#{version}-linux-arm64"
      sha256 "d574ea863941e200b5a694c8b4a83d08b149c20ed55b94721e0bf00395653985"
    end
    on_intel do
      url "https://github.com/AstrolexisAI/KCode/releases/download/v#{version}/kcode-#{version}-linux-x64"
      sha256 "212e26b9c426ef30d1f3c5330854040ab7b10c6d5677fa3c22018ab0b9203820"
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
