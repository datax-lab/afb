import sys
import numpy as np

import torch
from torchvision import transforms

device = "cuda" if torch.cuda.is_available() else "cpu"
model = torch.load('./model/test.pth', map_location=torch.device(device))

transforms = transforms.Compose([transforms.Resize((256,256)), transforms.ToTensor()])

def detect(image):
  sample = torch.unsqueeze(transforms(image), dim=0).to(device)
  result = model(sample).item()
  return result

def score(image):
    a = np.asarray(image).reshape(-1, 3).transpose().astype(int)
    return np.count_nonzero(
        (((a[0]) - a[2]) > 10) & # more red than blue
        (((a[0]) - a[1]) > 30)   # more red than green
    )