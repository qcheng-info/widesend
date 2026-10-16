import { File } from 'lucide-react';

export function FileIcon({ name }: { name: string }) {
  return (
    <span className="file-icon">
      <File size={22} />
      <small>
        {name.split('.').length > 1 ? name.split('.').pop()!.slice(0, 4).toUpperCase() : ''}
      </small>
    </span>
  );
}
