import json, numpy as np, pandas as pd
import features as FT
rng=np.random.default_rng(11)
N=1000; I=N-1-6
idx=pd.date_range('2026-09-01 00:00',periods=N,freq='h')
# synthetic haze-ish PM
base=70+15*np.sin(np.arange(N)/40)+rng.normal(0,4,N); pm_mean=pd.Series(np.clip(base,3,None),index=idx)
wx={}
pts=list(FT.POINTS)
def mk(f): return pd.DataFrame({p:f(p) for p in pts},index=idx)
wx['temp']=mk(lambda p:28+rng.normal(0,1.5,N)); wx['rh']=mk(lambda p:np.clip(75+rng.normal(0,10,N),20,100))
wx['precip']=mk(lambda p:np.where(rng.random(N)<.15,rng.exponential(1.5,N),0.0))
wx['wspd']=mk(lambda p:np.abs(3+rng.normal(0,1.5,N))); wx['wdir']=mk(lambda p:rng.uniform(0,360,N))
wx['blh']=mk(lambda p:np.abs(600+rng.normal(0,200,N)))
# detections
nd=4000
pos=rng.integers(I-130,I+3,nd)
hr=idx[pos]
lat=rng.uniform(-6,6,nd); lon=rng.uniform(95,119,nd)
frp=rng.exponential(30,nd); frp[rng.random(nd)<.1]=np.nan
dets=pd.DataFrame({'hr':hr,'lat':lat,'lon':lon,'frp':frp})
dist=np.stack([FT.haversine_km(lat,lon,*FT.POINTS[p]) for p in FT.SRC]); cell=np.array(FT.SRC)[dist.argmin(0)]
counts=pd.DataFrame({'hr':hr,'cell':cell}).groupby(['hr','cell']).size().unstack(fill_value=0).reindex(idx,fill_value=0).reindex(columns=FT.SRC,fill_value=0)
up=pd.DataFrame({p:np.clip(rng.normal(40,15,N),1,None) for p in FT.UP_SRC},index=idx)
F=FT.compute(pm_mean,wx,counts,wx,dets,up)
row=F.iloc[I]
out={'I':I,'hourSGT':int(idx[I].value//3.6e12),'pm':pm_mean.tolist(),
 'wx':{k:{p:v[p].tolist() for p in pts} for k,v in wx.items()},
 'counts':{p:counts[p].tolist() for p in FT.SRC},
 'dets':[{'pos':int(a),'lat':float(b),'lon':float(c),'frp':(None if np.isnan(d) else float(d))} for a,b,c,d in zip(pos,lat,lon,frp)],
 'up':{p:up[p].tolist() for p in FT.UP_SRC},'expected':{k:(None if np.isnan(v) else float(v)) for k,v in row.items()}}
json.dump(out,open('case.json','w'))
print(row.round(4).to_dict())
