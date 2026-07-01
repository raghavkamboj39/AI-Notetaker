from PIL import Image
import numpy as np
import os

src = "/Users/raghavkamboj/Desktop/notetaker-fresh/assets/icon.png"
dst = "/Users/raghavkamboj/Desktop/notetaker-fresh/assets/icon.png"

img = Image.open(src).convert("RGBA")
data = np.array(img)

r, g, b, a = data[:,:,0], data[:,:,1], data[:,:,2], data[:,:,3]
white_mask = (r > 220) & (g > 220) & (b > 220)
data[white_mask] = [0, 0, 0, 0]

result = Image.fromarray(data)
result.save(dst)
print("Done! Background removed.")
