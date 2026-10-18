"""Resolve exact push/PR endpoints; new branches compare with an empty tree."""
import json
import os
import subprocess
from pathlib import Path


def git(*args, input=None):
    return subprocess.check_output(['git', *args], input=input).decode().strip()


def main():
    event = json.loads(Path(os.environ['GITHUB_EVENT_PATH']).read_text())
    if 'pull_request' in event:
        head = event['pull_request']['head']['sha']
        base = git('merge-base', event['pull_request']['base']['sha'], head)
    else:
        head, base = event['after'], event['before']
        if not base.strip('0'):
            base = git('hash-object', '-w', '-t', 'tree', '--stdin', input=b'')
    with open(os.environ['GITHUB_OUTPUT'], 'a') as stream:
        stream.write(f'base={base}\nhead={head}\n')


if __name__ == '__main__':
    main()
