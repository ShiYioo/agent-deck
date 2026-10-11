# -*- coding: utf-8 -*-
# 补丁 1：插入 manifest 快照/分类函数 + 重写 get_turn_artifacts（基线驱动）
p = 'src-tauri/src/lib.rs'
c = open(p, encoding='utf-8').read()

start_marker = 'fn get_turn_artifacts(store: State<'
end_marker = 'fn undo_task_file(store: State<'

new_block = open('_patch1_block.txt', encoding='utf-8').read()

sig_idx = c.index(start_marker)
end_idx = c.index(end_marker, sig_idx)
c = c[:sig_idx] + new_block + '\n' + c[end_idx:]
open(p, 'w', encoding='utf-8', newline='\n').write(c)
print('patch1 done')
