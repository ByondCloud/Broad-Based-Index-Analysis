import urllib.request, os

UA = {'User-Agent': 'Mozilla/5.0'}
urls = [
    'https://cdn.jsdelivr.net/npm/echarts@5.5.1/dist/echarts.min.js',
    'https://unpkg.com/echarts@5.5.1/dist/echarts.min.js',
    'https://cdnjs.cloudflare.com/ajax/libs/echarts/5.5.1/echarts.min.js',
    'https://registry.npmmirror.com/echarts/5.5.1/files/dist/echarts.min.js',
    'https://cdn.staticfile.org/echarts/5.5.1/echarts.min.js',
]
os.makedirs('../web/vendor', exist_ok=True)
for u in urls:
    try:
        b = urllib.request.urlopen(urllib.request.Request(u, headers=UA), timeout=90).read()
        if len(b) > 500000:
            open('../web/vendor/echarts.min.js', 'wb').write(b)
            print('OK', u, len(b))
            break
        print('small', u, len(b))
    except Exception as e:
        print('ERR', u, repr(e)[:100])
