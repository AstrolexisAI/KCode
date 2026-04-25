# Positive fixture for rb-013-ssrf-net-http.
# Net::HTTP.get on params[:url] — attacker reaches internal services
# or AWS metadata via http://169.254.169.254.
require 'net/http'

class WebhookController
  def proxy
    Net::HTTP.get(URI(params[:url]))
  end
end
