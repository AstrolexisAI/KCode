# Positive fixture for rb-014-send-file-traversal.
# send_file with params-derived path — `?file=../../etc/passwd`
# walks out of the public dir.
class DownloadsController
  def show
    send_file Rails.root.join('public', 'downloads', params[:file])
  end
end
