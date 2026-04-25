# Negative fixture for rb-014-send-file-traversal.
# Look up by ID, never by filename; serve from a model record.
class DownloadsController
  def show
    record = Document.find(params[:id])
    send_file record.storage_path, filename: record.original_name
  end
end
