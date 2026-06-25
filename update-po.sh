#!/bin/bash
mkdir -p po
xgettext --from-code=UTF-8 \
  --add-comments \
  --keyword=_ \
  --keyword=N_ \
  --package-name="Yet Another Radio" \
  --output=po/yetanotherradio.pot \
  yetanotherradio@io.github.buddysirjava/*.js \
  yetanotherradio@io.github.buddysirjava/modules/*.js \
  yetanotherradio@io.github.buddysirjava/schemas/*.xml

for po_file in po/*.po; do
  [ -f "$po_file" ] || continue
  msgmerge --update --no-fuzzy-matching "$po_file" po/yetanotherradio.pot
done
