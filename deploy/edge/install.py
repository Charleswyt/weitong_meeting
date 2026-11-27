"""Install one packaged board release. Run as root with the platform config and the enrolled cloud certificate."""
import argparse
import grp
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
from urllib.parse import urlsplit

def run(*args):
    return subprocess.run(args, check=True, capture_output=True, text=True).stdout

def install_file(path, data, group, mode):
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as f:
        f.write(data)
        os.fchown(f.fileno(), 0, group)
        os.fchmod(f.fileno(), mode)
        os.fsync(f.fileno())
    os.replace(f.name, path)

def main():
    p = argparse.ArgumentParser()
    p.add_argument('release', type=Path)
    p.add_argument('platform', type=Path)
    p.add_argument('cloud_cert', type=Path)
    p.add_argument('--ip', required=True, type=ipaddress.ip_address)
    p.add_argument('--origin', required=True)
    p.add_argument('--port', type=int, default=38765)
    a = p.parse_args()
    cfg = json.loads(a.platform.read_bytes())
    origin = urlsplit(a.origin)
    if origin.scheme != 'https' or not origin.hostname or origin.path or origin.query or origin.fragment or origin.username:
        p.error('provide an HTTPS cloud origin')
    run('openssl', 'x509', '-noout', '-checkip', str(a.ip), '-in', cfg['tlsCert'])
    run('openssl', 'x509', '-noout', '-checkend', '0', '-in', str(a.cloud_cert))
    root, etc = Path('/opt/weitong-edge'), Path('/etc/weitong-edge')
    root.mkdir(mode=0o755, exist_ok=True)
    try:
        group = grp.getgrnam('weitong-edge').gr_gid
    except KeyError:
        run('useradd', '--system', '--user-group', '--home-dir', '/nonexistent', '--shell', '/usr/sbin/nologin', 'weitong-edge')
        group = grp.getgrnam('weitong-edge').gr_gid
    etc.mkdir(mode=0o750, exist_ok=True)
    os.chown(etc, 0, group)
    manifest = json.loads((a.release / 'files.json').read_bytes())
    tag = hashlib.sha256((a.release / 'files.json').read_bytes()).hexdigest()[:16]
    dst = root / tag
    for n,h in manifest.items():
        if n.startswith('/') or '..' in Path(n).parts or hashlib.sha256((a.release/n).read_bytes()).hexdigest()!=h:
            raise ValueError('release verification failed')
    if not dst.exists():
        stage = Path(tempfile.mkdtemp(dir=root))
        try:
            for n in manifest:
                target = stage/n
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(a.release/n, target)
                target.chmod(0o755 if n in ('edge','uplink') else 0o644)
            stage.chmod(0o755)
            stage.rename(dst)
        finally:
            if stage.exists(): shutil.rmtree(stage)
    identity = etc/'identity'
    if not identity.exists():
        pub = run(str(dst/'edge'), '-generate-key', str(identity)).strip()
        install_file(etc/'public.key', (pub+'\n').encode(), group, 0o640)
    os.chown(identity, 0, group)
    identity.chmod(0o640)
    for src,n in [(Path(cfg['tlsCert']),'tls.crt'),(Path(cfg['tlsKey']),'tls.key'),(a.cloud_cert,'cloud.crt')]:
        install_file(etc/n, src.read_bytes(), group, 0o640)
    settings = dict(listen=f'{a.ip}:{a.port}', origin=a.origin, cloudCert=str(etc/'cloud.crt'), tlsCert=str(etc/'tls.crt'), tlsKey=str(etc/'tls.key'),
                    identity=str(identity), node=cfg['nodeId'], dist=str(root/'current/dist'), media='http://127.0.0.1:18689', binaries='/opt/rtsp_roi/app/bin', uplink=str(root/'current/uplink'))
    install_file(etc/'config.json', json.dumps(settings).encode(), group, 0o640)
    temp = root/('.current-'+str(os.getpid()))
    temp.symlink_to(dst)
    os.replace(temp,root/'current')
    install_file(Path('/etc/systemd/system/weitong-edge.service'), (dst/'weitong-edge.service').read_bytes(), 0, 0o644)
    run('systemctl','daemon-reload')
    run('systemctl','enable','weitong-edge.service')
    run('systemctl','restart','weitong-edge.service')
    print(json.dumps(dict(node=cfg['nodeId'],release=tag,publicKey=(etc/'public.key').read_text().strip(),url=f'https://{a.ip}:{a.port}/zwt-meeting/')))

if __name__=='__main__':
    main()
