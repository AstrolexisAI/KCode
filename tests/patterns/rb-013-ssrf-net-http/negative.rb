# Negative fixture for rb-013-ssrf-net-http.
# Validate scheme + allowlist + block private IPs before fetching.
require 'net/http'
require 'ipaddr'
require 'resolv'

ALLOWED_HOSTS = %w[api.partner.example hooks.partner.example].freeze

class SafeWebhookController
  def proxy
    url = Rails.application.credentials.partner_webhook_base
    u = URI.parse(url)
    return unless u.scheme == 'https' && ALLOWED_HOSTS.include?(u.host)
    ip = IPAddr.new(Resolv.getaddress(u.host))
    return if ip.private? || ip.loopback? || ip.link_local?
    Net::HTTP.get(u)
  end
end
